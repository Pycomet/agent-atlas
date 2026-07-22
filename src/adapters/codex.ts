import { createReadStream, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parse as parseToml } from 'smol-toml';
import type { ToolAdapter } from '../adapter.js';
import type { Inventory, InventoryItem, McpTransport, Usage, UsageEntry } from '../types.js';
import {
  dirExists,
  fileExists,
  fileSize,
  prefixInventory,
  prefixUsage,
  readFileSafe,
} from './shared.js';

const DAY_MS = 86_400_000;

/**
 * Codex CLI adapter (SPEC_V2 §3 Tier A). Covers the documented CLI layout:
 * `~/.codex/config.toml` ([mcp_servers.<name>] tables) and rollout logs at
 * `~/.codex/sessions/**\/*.jsonl`. The Codex desktop app stores state in
 * internal SQLite files with no stable public surface — on such machines
 * detect() is false rather than pretending (verified 2026-07-22).
 */

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function transportOf(server: Record<string, unknown>): McpTransport {
  if (typeof server['url'] === 'string') return 'http';
  if (typeof server['command'] === 'string') return 'stdio';
  return 'unknown';
}

async function scanCodex(homeDir: string, projectDir?: string): Promise<Inventory> {
  const items: InventoryItem[] = [];
  const configPath = join(homeDir, '.codex', 'config.toml');
  const configText = await readFileSafe(configPath);
  if (configText !== null) {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = parseToml(configText) as Record<string, unknown>;
    } catch {
      parsed = null; // corrupt config → empty inventory section, never a crash
    }
    const servers = asRecord(parsed?.['mcp_servers'] ?? null);
    if (servers !== null) {
      for (const [name, raw] of Object.entries(servers)) {
        const server = asRecord(raw);
        if (server === null) continue;
        items.push({
          id: `mcp:${name}`,
          kind: 'mcp',
          name,
          description: null,
          sourcePath: configPath,
          sizeBytes: Buffer.byteLength(JSON.stringify(server), 'utf8'),
          transport: transportOf(server),
        });
      }
    }
  }

  const memorySources: Array<[string, string]> = [
    [join(homeDir, '.codex', 'AGENTS.md'), 'global'],
  ];
  if (projectDir !== undefined) {
    memorySources.push([join(projectDir, 'AGENTS.md'), 'project']);
  }
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

/** `github__search_issues` / `mcp__github__search` → `github`; plain tools → null. */
function mcpServerOf(name: string): string | null {
  const stripped = name.startsWith('mcp__') ? name.slice('mcp__'.length) : name;
  if (!stripped.includes('__')) return null;
  const server = stripped.split('__')[0];
  return server !== undefined && server !== '' ? server : null;
}

async function* jsonlFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonlFiles(path);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield path;
  }
}

async function mineCodex(homeDir: string, days: number, now: Date): Promise<Usage> {
  const cutoff = now.getTime() - days * DAY_MS;
  const tallies = new Map<string, { count: number; lastUsed: number; sessions: number }>();
  let totalSessions = 0;

  for await (const file of jsonlFiles(join(homeDir, '.codex', 'sessions'))) {
    const seenInSession = new Set<string>();
    let sessionInWindow = false;
    const reader = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of reader) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const record = asRecord(parsed);
      if (record === null) continue;
      const ts =
        typeof record['timestamp'] === 'string' ? Date.parse(record['timestamp']) : Number.NaN;
      if (Number.isNaN(ts) || ts < cutoff || ts > now.getTime()) continue;
      sessionInWindow = true;

      // Rollout lines wrap the item under `payload` (older logs used `item`).
      const payload = asRecord(record['payload']) ?? asRecord(record['item']);
      if (payload === null || payload['type'] !== 'function_call') continue;
      const name = payload['name'];
      if (typeof name !== 'string') continue;
      const server = mcpServerOf(name);
      if (server === null) continue;

      const id = `mcp:${server}`;
      const tally = tallies.get(id) ?? { count: 0, lastUsed: 0, sessions: 0 };
      tally.count++;
      if (ts > tally.lastUsed) tally.lastUsed = ts;
      if (!seenInSession.has(id)) {
        seenInSession.add(id);
        tally.sessions++;
      }
      tallies.set(id, tally);
    }
    if (sessionInWindow) totalSessions++;
  }

  const items: Record<string, UsageEntry> = {};
  for (const [id, tally] of tallies) {
    items[id] = {
      count: tally.count,
      lastUsed: new Date(tally.lastUsed).toISOString(),
      sessionsSeen: tally.sessions,
    };
  }
  return { totalSessions, items };
}

export const codexAdapter: ToolAdapter = {
  name: 'codex',
  displayName: 'Codex CLI',
  usageSupport: 'full',
  detect: async (ctx) =>
    (await fileExists(join(ctx.homeDir, '.codex', 'config.toml'))) ||
    dirExists(join(ctx.homeDir, '.codex', 'sessions')),
  scan: async (ctx) => prefixInventory(await scanCodex(ctx.homeDir, ctx.projectDir), 'codex'),
  mineUsage: async (ctx) =>
    prefixUsage(await mineCodex(ctx.homeDir, ctx.days, ctx.now ?? new Date()), 'codex'),
};
