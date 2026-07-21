import { execFileSync, execSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Inventory, Usage } from '../src/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOME = join(ROOT, 'fixtures', 'home');
const PROJECT = join(ROOT, 'fixtures', 'project');
const CLI = join(ROOT, 'dist', 'cli.js');

interface CliJson {
  days: number;
  inventory: Inventory;
  usage: Usage;
}

const runCli = (...args: string[]): string =>
  execFileSync('node', [CLI, ...args], { encoding: 'utf8' });

describe('agent-atlas CLI', () => {
  beforeAll(() => {
    execSync('npm run build', { cwd: ROOT, stdio: 'pipe' });
  }, 120_000);

  it('--json prints merged inventory + usage for the fixture tree', () => {
    // Wide window so the fixtures' static timestamps stay in range forever.
    const out = runCli('--json', '--home', HOME, '--project', PROJECT, '--days', '36500');
    const parsed = JSON.parse(out) as CliJson;

    expect(parsed.days).toBe(36500);
    expect(parsed.inventory.items).toHaveLength(15);
    expect(parsed.usage.totalSessions).toBe(3);

    // Every inventory item has a usage entry (zero-filled when never fired).
    for (const item of parsed.inventory.items) {
      expect(parsed.usage.items[item.id]).toBeDefined();
    }
    expect(parsed.usage.items['skill:git-workflow']).toEqual({
      count: 3,
      lastUsed: '2026-07-15T09:00:00.000Z',
      sessionsSeen: 3,
    });
    expect(parsed.usage.items['mcp:grafana']).toEqual({
      count: 0,
      lastUsed: null,
      sessionsSeen: 0,
    });
    expect(parsed.usage.items['skill:broken-skill']).toEqual({
      count: 0,
      lastUsed: null,
      sessionsSeen: 0,
    });
  });

  it('respects --days windowing', () => {
    // 2026-07-21 + 30d fixture window has long passed by any real "now";
    // with a tiny window nothing is in range.
    const out = runCli('--json', '--home', HOME, '--project', PROJECT, '--days', '1');
    const parsed = JSON.parse(out) as CliJson;
    expect(parsed.usage.totalSessions).toBe(0);
    expect(parsed.usage.items['skill:git-workflow']).toEqual({
      count: 0,
      lastUsed: null,
      sessionsSeen: 0,
    });
  });

  it('prints a human summary without --json', () => {
    const out = runCli('--home', HOME, '--project', PROJECT, '--days', '36500');
    expect(out).toContain('Agent Atlas');
    expect(out).toContain('sessions');
  });
});
