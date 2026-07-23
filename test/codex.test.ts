import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codexAdapter } from '../src/adapters/codex.js';
import type { AdapterContext } from '../src/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOME = join(ROOT, 'fixtures', 'codex-home');
const PROJECT = join(ROOT, 'fixtures', 'codex-project');
const NOW = new Date('2026-07-21T00:00:00.000Z');

const ctx = (homeDir: string, projectDir?: string): AdapterContext => ({
  homeDir,
  projectDir,
  days: 30,
  now: NOW,
});

describe('codexAdapter', () => {
  it('detects a home with .codex/config.toml and rejects an empty home', async () => {
    expect(await codexAdapter.detect(ctx(HOME))).toBe(true);
    expect(await codexAdapter.detect(ctx(mkdtempSync(join(tmpdir(), 'codex-empty-'))))).toBe(false);
  });

  it('scans MCP servers and AGENTS.md into codex/ namespaced items', async () => {
    const inventory = await codexAdapter.scan(ctx(HOME, PROJECT));
    const ids = inventory.items.map((i) => i.id).sort();
    expect(ids).toEqual([
      'codex/memory:global:AGENTS.md',
      'codex/memory:project:AGENTS.md',
      'codex/mcp:github',
      'codex/mcp:linear',
    ].sort());
    const github = inventory.items.find((i) => i.id === 'codex/mcp:github')!;
    expect(github.transport).toBe('stdio');
    expect(github.tool).toBe('codex');
    const linear = inventory.items.find((i) => i.id === 'codex/mcp:linear')!;
    expect(linear.transport).toBe('http');
  });

  it('mines MCP-attributable calls from session logs within the window', async () => {
    const usage = await codexAdapter.mineUsage(ctx(HOME));
    // rollout-old.jsonl is outside the 30-day window → 1 session, not 2.
    expect(usage.totalSessions).toBe(1);
    expect(usage.items['codex/mcp:github']).toEqual({
      count: 2,
      lastUsed: '2026-07-15T09:03:00.000Z',
      sessionsSeen: 1,
    });
    expect(usage.items['codex/mcp:linear']).toEqual({
      count: 1,
      lastUsed: '2026-07-15T09:02:00.000Z',
      sessionsSeen: 1,
    });
    // Plain tools (shell) are not inventory items — never counted.
    expect(Object.keys(usage.items)).toHaveLength(2);
  });

  it('survives corrupt config.toml with an empty inventory, no throw', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-corrupt-'));
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), '[mcp_servers.broken\nnot toml at all');
    const inventory = await codexAdapter.scan(ctx(home));
    expect(inventory.items).toEqual([]);
  });
});
