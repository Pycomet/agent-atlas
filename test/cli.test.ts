import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Axis, ClassificationOutput, Inventory, Usage } from '../src/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOME = join(ROOT, 'fixtures', 'home');
const PROJECT = join(ROOT, 'fixtures', 'project');
const CLI = join(ROOT, 'dist', 'cli.js');

interface CliJson {
  days: number;
  inventory: Inventory;
  usage: Usage;
  classification: ClassificationOutput;
}

// Tests must never reach the real API: strip Anthropic credentials from the child env.
const cleanEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env['ANTHROPIC_API_KEY'];
  delete env['ANTHROPIC_AUTH_TOKEN'];
  return env;
};

const runCli = (...args: string[]): string =>
  execFileSync('node', [CLI, ...args], { encoding: 'utf8', env: cleanEnv() });

const tmpAtlasDir = (): string => mkdtempSync(join(tmpdir(), 'agent-atlas-cli-test-'));

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

  it('without an API key, --json includes heuristic classification matching the hand labels', () => {
    const out = runCli(
      '--json',
      '--home',
      HOME,
      '--project',
      PROJECT,
      '--days',
      '36500',
      '--atlas-dir',
      tmpAtlasDir(),
    );
    const parsed = JSON.parse(out) as CliJson;
    const expected = JSON.parse(
      readFileSync(join(ROOT, 'fixtures', 'expected-classifications.json'), 'utf8'),
    ) as Record<string, Axis>;

    expect(parsed.classification.mode).toBe('heuristic');
    expect(parsed.classification.items).toHaveLength(Object.keys(expected).length);
    expect(parsed.classification.items.map((i) => i.itemId)).not.toContain(
      'memory:user:CLAUDE.md',
    );
    for (const [id, primary] of Object.entries(expected)) {
      const item = parsed.classification.items.find((i) => i.itemId === id);
      expect(item, `classification for ${id}`).toBeDefined();
      expect(item!.primary, `primary for ${id}`).toBe(primary);
    }
  });

  it('applies overrides from the atlas dir', () => {
    const atlasDir = tmpAtlasDir();
    writeFileSync(
      join(atlasDir, 'overrides.json'),
      JSON.stringify({ 'skill:git-workflow': { primary: 'design' } }),
    );
    const out = runCli(
      '--json',
      '--home',
      HOME,
      '--project',
      PROJECT,
      '--days',
      '36500',
      '--atlas-dir',
      atlasDir,
    );
    const parsed = JSON.parse(out) as CliJson;
    const item = parsed.classification.items.find((i) => i.itemId === 'skill:git-workflow')!;
    expect(item.method).toBe('override');
    expect(item.primary).toBe('design');
  });

  it('labels rough mode in the human summary and prints a tuning line', () => {
    const out = runCli(
      '--home',
      HOME,
      '--project',
      PROJECT,
      '--days',
      '36500',
      '--atlas-dir',
      tmpAtlasDir(),
    );
    expect(out).toContain('Tuning');
    expect(out.toLowerCase()).toContain('rough mode');
  });
});
