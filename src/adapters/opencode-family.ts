import { copyFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolAdapter } from '../adapter.js';
import type { Inventory, InventoryItem, Usage, UsageEntry } from '../types.js';
import {
  NO_USAGE,
  dirExists,
  fileExists,
  fileSize,
  prefixInventory,
  prefixUsage,
  readFileSafe,
} from './shared.js';

/**
 * Shared core for OpenCode-based tools — ORGN CDE and vanilla OpenCode
 * (SPEC_V2 §4.2). Inventory from `opencode.json(c)`; usage from the local
 * `opencode.db` SQLite session store, opened strictly read-only. Schema and
 * naming verified against a real install — see docs/opencode-db-survey.md.
 */

/**
 * Strip `//` line comments, `/* *​/` block comments, and trailing commas —
 * string-aware, because naive regex stripping corrupts URLs in string values
 * (`"$schema": "https://…"`). Returns null on unparseable input.
 */
export function parseJsonc(text: string): Record<string, unknown> | null {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  out = out.replace(/,\s*([}\]])/g, '$1');
  try {
    const parsed: unknown = JSON.parse(out);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export interface OpencodePaths {
  /** Directory holding opencode.json / opencode.jsonc. */
  configDir: string;
  /** Directory holding opencode.db. */
  dataDir: string;
}

async function findConfig(configDir: string): Promise<string | null> {
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    const path = join(configDir, name);
    if (await fileExists(path)) return path;
  }
  return null;
}

async function scanOpencode(paths: OpencodePaths, projectDir?: string): Promise<Inventory> {
  const items: InventoryItem[] = [];
  const configPath = await findConfig(paths.configDir);
  if (configPath !== null) {
    const text = await readFileSafe(configPath);
    const config = text !== null ? parseJsonc(text) : null;
    const sections: Array<['agent' | 'mcp' | 'command', 'agent' | 'mcp' | 'command']> = [
      ['agent', 'agent'],
      ['mcp', 'mcp'],
      ['command', 'command'],
    ];
    for (const [key, kind] of sections) {
      const section = asRecord(config?.[key] ?? null);
      if (section === null) continue;
      for (const [name, raw] of Object.entries(section)) {
        const entry = asRecord(raw);
        if (entry === null) continue;
        const description =
          typeof entry['description'] === 'string' ? entry['description'] : null;
        items.push({
          id: `${kind}:${name}`,
          kind,
          name,
          description,
          sourcePath: configPath,
          sizeBytes: Buffer.byteLength(JSON.stringify(entry), 'utf8'),
        });
      }
    }
  }
  const memorySources: Array<[string, string]> = [[join(paths.configDir, 'AGENTS.md'), 'global']];
  if (projectDir !== undefined) memorySources.push([join(projectDir, 'AGENTS.md'), 'project']);
  for (const [path, scope] of memorySources) {
    if (await fileExists(path)) {
      items.push({
        id: `memory:${scope}:AGENTS.md`,
        kind: 'memory',
        name: `AGENTS.md (${scope})`,
        description: null,
        sourcePath: path,
        sizeBytes: await fileSize(path),
      });
    }
  }
  return { items };
}

interface ToolRow {
  tool: string;
  time_created: number;
  session_id: string;
}
interface AgentRow {
  agent: string;
  time_created: number;
  session_id: string;
}

/** Longest config-key prefix match: `origin-edge-mcp_health_check` → `origin-edge-mcp`. */
function mcpServerFor(tool: string, serverNames: string[]): string | null {
  let best: string | null = null;
  for (const server of serverNames) {
    if (tool.startsWith(`${server}_`) && (best === null || server.length > best.length)) {
      best = server;
    }
  }
  return best;
}

async function mineOpencode(
  paths: OpencodePaths,
  days: number,
  now: Date,
  serverNames: string[],
  agentNames: string[],
): Promise<Usage> {
  const dbPath = join(paths.dataDir, 'opencode.db');
  if (!(await fileExists(dbPath))) return NO_USAGE;

  // process.getBuiltinModule avoids bundler static-import analysis and
  // returns undefined (or throws) where the builtin is missing (Node < 22.5).
  let DatabaseSync: (typeof import('node:sqlite'))['DatabaseSync'];
  try {
    const sqlite = process.getBuiltinModule('node:sqlite');
    if (sqlite === undefined) return NO_USAGE;
    ({ DatabaseSync } = sqlite);
  } catch {
    return NO_USAGE; // degrade to inventory-only (SPEC_V2 §4.2)
  }

  // A running CDE holds a WAL lock; copy-on-read keeps us strictly hands-off.
  let openPath = dbPath;
  if (await fileExists(`${dbPath}-wal`)) {
    try {
      const tmp = await mkdtemp(join(tmpdir(), 'agent-atlas-oc-'));
      openPath = join(tmp, 'opencode.db');
      await copyFile(dbPath, openPath);
      if (await fileExists(`${dbPath}-wal`)) {
        await copyFile(`${dbPath}-wal`, `${openPath}-wal`).catch(() => undefined);
      }
    } catch {
      openPath = dbPath;
    }
  }

  const cutoffMs = now.getTime() - days * 86_400_000;
  const tallies = new Map<string, { count: number; lastUsed: number; sessions: Set<string> }>();
  const sessions = new Set<string>();

  const bump = (id: string, ts: number, session: string): void => {
    const tally = tallies.get(id) ?? { count: 0, lastUsed: 0, sessions: new Set<string>() };
    tally.count++;
    if (ts > tally.lastUsed) tally.lastUsed = ts;
    tally.sessions.add(session);
    tallies.set(id, tally);
  };

  try {
    const db = new DatabaseSync(openPath, { readOnly: true });
    try {
      const toolRows = db
        .prepare(
          `SELECT json_extract(data,'$.tool') AS tool, time_created, session_id
             FROM part
            WHERE json_extract(data,'$.type')='tool' AND time_created >= ?`,
        )
        .all(cutoffMs) as unknown as ToolRow[];
      for (const row of toolRows) {
        if (typeof row.tool !== 'string' || row.tool === '') continue;
        sessions.add(row.session_id);
        const server = mcpServerFor(row.tool, serverNames);
        if (server !== null) bump(`mcp:${server}`, row.time_created, row.session_id);
      }

      const agentRows = db
        .prepare(
          `SELECT json_extract(data,'$.agent') AS agent, time_created, session_id
             FROM message
            WHERE json_extract(data,'$.agent') IS NOT NULL AND time_created >= ?`,
        )
        .all(cutoffMs) as unknown as AgentRow[];
      for (const row of agentRows) {
        if (typeof row.agent !== 'string' || row.agent === '') continue;
        sessions.add(row.session_id);
        if (agentNames.includes(row.agent)) bump(`agent:${row.agent}`, row.time_created, row.session_id);
      }
    } finally {
      db.close();
    }
  } catch {
    return NO_USAGE; // schema surprise or locked DB — never crash, never write
  }

  const items: Record<string, UsageEntry> = {};
  for (const [id, tally] of tallies) {
    items[id] = {
      count: tally.count,
      lastUsed: new Date(tally.lastUsed).toISOString(),
      sessionsSeen: tally.sessions.size,
    };
  }
  return { totalSessions: sessions.size, items };
}

export function makeOpencodeAdapter(options: {
  name: string;
  displayName: string;
  paths: (homeDir: string) => OpencodePaths;
}): ToolAdapter {
  return {
    name: options.name,
    displayName: options.displayName,
    usageSupport: 'partial',
    detect: async (ctx) => {
      const paths = options.paths(ctx.homeDir);
      return (await findConfig(paths.configDir)) !== null || dirExists(paths.dataDir);
    },
    scan: async (ctx) =>
      prefixInventory(await scanOpencode(options.paths(ctx.homeDir), ctx.projectDir), options.name),
    mineUsage: async (ctx) => {
      const paths = options.paths(ctx.homeDir);
      const inventory = await scanOpencode(paths, ctx.projectDir);
      const serverNames = inventory.items.filter((i) => i.kind === 'mcp').map((i) => i.name);
      const agentNames = inventory.items.filter((i) => i.kind === 'agent').map((i) => i.name);
      return prefixUsage(
        await mineOpencode(paths, ctx.days, ctx.now ?? new Date(), serverNames, agentNames),
        options.name,
      );
    },
  };
}

export const orgnCdeAdapter = makeOpencodeAdapter({
  name: 'orgn-cde',
  displayName: 'ORGN CDE',
  paths: (homeDir) => ({
    configDir: join(homeDir, '.config', 'orgn'),
    dataDir: join(homeDir, '.local', 'share', 'orgn'),
  }),
});

export const opencodeAdapter = makeOpencodeAdapter({
  name: 'opencode',
  displayName: 'OpenCode',
  paths: (homeDir) => ({
    configDir: join(homeDir, '.config', 'opencode'),
    dataDir: join(homeDir, '.local', 'share', 'opencode'),
  }),
});
