import { createReadStream } from 'node:fs';
import type { Dirent } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Inventory, MineOptions, Usage, UsageEntry } from './types.js';

const DAY_MS = 86_400_000;

async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Map a transcript tool_use block to an inventory item id, or null. */
function itemIdForBlock(blockRaw: unknown): string | null {
  if (typeof blockRaw !== 'object' || blockRaw === null) return null;
  const block = blockRaw as Record<string, unknown>;
  if (block['type'] !== 'tool_use' || typeof block['name'] !== 'string') return null;
  const name = block['name'];
  const input =
    typeof block['input'] === 'object' && block['input'] !== null
      ? (block['input'] as Record<string, unknown>)
      : {};

  if (name === 'Skill') {
    return typeof input['skill'] === 'string' ? `skill:${input['skill']}` : null;
  }
  if (name === 'Task' || name === 'Agent') {
    return typeof input['subagent_type'] === 'string' ? `agent:${input['subagent_type']}` : null;
  }
  if (name.startsWith('mcp__')) {
    const server = name.slice('mcp__'.length).split('__')[0];
    return server ? `mcp:${server}` : null;
  }
  return null;
}

interface Tally {
  count: number;
  lastUsed: number;
  sessions: number;
}

/**
 * Streams `~/.claude/projects/* /*.jsonl` line by line (transcripts can be
 * large — never load whole files, spec §4.2). Corrupt or unknown lines are
 * skipped; usage degrades to 0 rather than crashing.
 */
export async function mineUsage(opts: MineOptions): Promise<Usage> {
  const days = opts.days ?? 30;
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - days * DAY_MS;

  const projectsDir = join(opts.homeDir, '.claude', 'projects');
  const tallies = new Map<string, Tally>();
  let totalSessions = 0;

  for (const projectEntry of await readDirSafe(projectsDir)) {
    if (!projectEntry.isDirectory()) continue;
    const projectPath = join(projectsDir, projectEntry.name);
    for (const fileEntry of await readDirSafe(projectPath)) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith('.jsonl')) continue;

      // One .jsonl file = one session.
      const seenInSession = new Set<string>();
      let sessionInWindow = false;
      const reader = createInterface({
        input: createReadStream(join(projectPath, fileEntry.name)),
        crlfDelay: Infinity,
      });
      for await (const line of reader) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof parsed !== 'object' || parsed === null) continue;
        const record = parsed as Record<string, unknown>;

        const ts =
          typeof record['timestamp'] === 'string' ? Date.parse(record['timestamp']) : Number.NaN;
        if (Number.isNaN(ts) || ts < cutoff || ts > now.getTime()) continue;
        sessionInWindow = true;

        const message =
          typeof record['message'] === 'object' && record['message'] !== null
            ? (record['message'] as Record<string, unknown>)
            : null;
        const content = message?.['content'];
        if (!Array.isArray(content)) continue;

        for (const block of content) {
          const id = itemIdForBlock(block);
          if (id === null) continue;
          const tally = tallies.get(id) ?? { count: 0, lastUsed: 0, sessions: 0 };
          tally.count++;
          if (ts > tally.lastUsed) tally.lastUsed = ts;
          if (!seenInSession.has(id)) {
            seenInSession.add(id);
            tally.sessions++;
          }
          tallies.set(id, tally);
        }
      }
      if (sessionInWindow) totalSessions++;
    }
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

/**
 * Every inventory item gets a usage entry; items never seen get zeros —
 * that's the dead-weight signal, not an error (spec §4.2). Usage entries
 * for items no longer installed are kept.
 */
export function mergeUsage(inventory: Inventory, usage: Usage): Usage {
  const items: Record<string, UsageEntry> = {};
  for (const item of inventory.items) {
    items[item.id] = usage.items[item.id] ?? { count: 0, lastUsed: null, sessionsSeen: 0 };
  }
  for (const [id, entry] of Object.entries(usage.items)) {
    if (!(id in items)) items[id] = entry;
  }
  return { totalSessions: usage.totalSessions, items };
}
