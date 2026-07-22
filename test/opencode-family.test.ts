import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  makeOpencodeAdapter,
  orgnCdeAdapter,
  parseJsonc,
} from '../src/adapters/opencode-family.js';
import type { AdapterContext } from '../src/types.js';

const NOW = new Date('2026-07-21T00:00:00.000Z');
const IN_WINDOW = NOW.getTime() - 86_400_000; // 1 day before NOW, epoch ms
const OUT_OF_WINDOW = NOW.getTime() - 90 * 86_400_000;

const CONFIG_JSONC = `{
  // JSONC comment — and a URL with slashes that must survive stripping:
  "$schema": "https://opencode.ai/config.json",
  "model": "ollm/near_gpt_oss_120b",
  "agent": {
    "build": { "description": "Implements features from specs" },
    "review": { "description": "Reviews diffs for bugs" },
  },
  "mcp": {
    "origin-edge-mcp": { "type": "remote", "url": "https://edge.example.com/mcp" },
  },
  "command": {
    "ship": { "description": "Run the release checklist" },
  },
}`;

/** Build a fake ORGN-CDE home: config + a surveyed-schema sqlite DB. */
async function makeHome(withDb: boolean): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), 'oc-home-'));
  const configDir = join(home, '.config', 'orgn');
  const dataDir = join(home, '.local', 'share', 'orgn');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(configDir, 'opencode.jsonc'), CONFIG_JSONC);

  if (withDb) {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')!;
    const db = new DatabaseSync(join(dataDir, 'opencode.db'));
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, time_created INTEGER);
             CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`);
    const part = db.prepare('INSERT INTO part VALUES (?,?,?,?,?)');
    part.run('p1', 'm1', 's1', IN_WINDOW, JSON.stringify({ type: 'tool', tool: 'origin-edge-mcp_health_check' }));
    part.run('p2', 'm1', 's1', IN_WINDOW, JSON.stringify({ type: 'tool', tool: 'origin-edge-mcp_create_task' }));
    part.run('p3', 'm2', 's2', IN_WINDOW, JSON.stringify({ type: 'tool', tool: 'read' }));
    part.run('p4', 'm3', 's3', OUT_OF_WINDOW, JSON.stringify({ type: 'tool', tool: 'origin-edge-mcp_health_check' }));
    const message = db.prepare('INSERT INTO message VALUES (?,?,?,?)');
    message.run('m1', 's1', IN_WINDOW, JSON.stringify({ role: 'user', agent: 'build' }));
    message.run('m2', 's2', IN_WINDOW, JSON.stringify({ role: 'user', agent: 'unregistered-agent' }));
    db.close();
  }
  return home;
}

const ctx = (homeDir: string): AdapterContext => ({ homeDir, days: 30, now: NOW });

describe('parseJsonc', () => {
  it('strips comments and trailing commas without corrupting URLs in strings', () => {
    const parsed = parseJsonc(CONFIG_JSONC)!;
    expect(parsed['$schema']).toBe('https://opencode.ai/config.json');
    expect(Object.keys(parsed['agent'] as object)).toEqual(['build', 'review']);
  });

  it('handles block comments and escaped quotes', () => {
    expect(parseJsonc('{/* x */ "a": "say \\"hi\\" // not a comment", }')).toEqual({
      a: 'say "hi" // not a comment',
    });
  });

  it('returns null on corrupt input instead of throwing', () => {
    expect(parseJsonc('{ not json')).toBeNull();
  });
});

describe('orgn-cde adapter (opencode family)', () => {
  it('detects via config or data dir; rejects an empty home', async () => {
    expect(await orgnCdeAdapter.detect(ctx(await makeHome(false)))).toBe(true);
    expect(await orgnCdeAdapter.detect(ctx(mkdtempSync(join(tmpdir(), 'oc-empty-'))))).toBe(false);
  });

  it('scans agents, MCP servers, and commands from opencode.jsonc', async () => {
    const inventory = await orgnCdeAdapter.scan(ctx(await makeHome(false)));
    const ids = inventory.items.map((i) => i.id).sort();
    expect(ids).toEqual([
      'orgn-cde/agent:build',
      'orgn-cde/agent:review',
      'orgn-cde/command:ship',
      'orgn-cde/mcp:origin-edge-mcp',
    ]);
    const build = inventory.items.find((i) => i.id === 'orgn-cde/agent:build')!;
    expect(build.description).toBe('Implements features from specs');
    expect(build.tool).toBe('orgn-cde');
  });

  it('mines MCP + registered-agent usage from the sqlite store within the window', async () => {
    const usage = await orgnCdeAdapter.mineUsage(ctx(await makeHome(true)));
    expect(usage.totalSessions).toBe(2); // s1, s2 in window; s3 outside
    expect(usage.items['orgn-cde/mcp:origin-edge-mcp']).toMatchObject({
      count: 2,
      sessionsSeen: 1,
    });
    expect(usage.items['orgn-cde/agent:build']).toMatchObject({ count: 1, sessionsSeen: 1 });
    // Unregistered agents and builtin tools are never counted.
    expect(usage.items['orgn-cde/agent:unregistered-agent']).toBeUndefined();
  });

  it('degrades to zero usage when the DB is missing or has a foreign schema', async () => {
    const noDb = await orgnCdeAdapter.mineUsage(ctx(await makeHome(false)));
    expect(noDb).toEqual({ totalSessions: 0, items: {} });

    const home = await makeHome(false);
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')!;
    const db = new DatabaseSync(join(home, '.local', 'share', 'orgn', 'opencode.db'));
    db.exec('CREATE TABLE something_else (id TEXT)');
    db.close();
    const foreign = await orgnCdeAdapter.mineUsage(ctx(home));
    expect(foreign).toEqual({ totalSessions: 0, items: {} });
  });

  it('makeOpencodeAdapter builds the vanilla opencode variant from different paths', async () => {
    const adapter = makeOpencodeAdapter({
      name: 'opencode',
      displayName: 'OpenCode',
      paths: (homeDir) => ({
        configDir: join(homeDir, '.config', 'opencode'),
        dataDir: join(homeDir, '.local', 'share', 'opencode'),
      }),
    });
    expect(await adapter.detect(ctx(await makeHome(false)))).toBe(false); // orgn dirs ≠ opencode dirs
  });
});
