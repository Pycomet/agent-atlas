import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cursorAdapter } from '../src/adapters/cursor.js';
import type { AdapterContext } from '../src/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOME = join(ROOT, 'fixtures', 'cursor-home');
const PROJECT = join(ROOT, 'fixtures', 'cursor-project');

const ctx = (homeDir: string, projectDir?: string): AdapterContext => ({
  homeDir,
  projectDir,
  days: 30,
});

describe('cursorAdapter', () => {
  it('is inventory-only and detects via ~/.cursor', async () => {
    expect(cursorAdapter.usageSupport).toBe('none');
    expect(await cursorAdapter.detect(ctx(HOME))).toBe(true);
    expect(await cursorAdapter.detect(ctx(mkdtempSync(join(tmpdir(), 'cursor-empty-'))))).toBe(false);
    expect(await cursorAdapter.mineUsage(ctx(HOME))).toEqual({ totalSessions: 0, items: {} });
  });

  it('scans MCP servers with project config winning name collisions', async () => {
    const inventory = await cursorAdapter.scan(ctx(HOME, PROJECT));
    const github = inventory.items.find((i) => i.id === 'cursor/mcp:github')!;
    expect(github.transport).toBe('http'); // project override, not the global stdio one
    expect(github.sourcePath).toContain('cursor-project');
    const names = inventory.items.filter((i) => i.kind === 'mcp').map((i) => i.name).sort();
    expect(names).toEqual(['github', 'playwright', 'trigger']);
  });

  it('scans skills-cursor skills and project rules files', async () => {
    const inventory = await cursorAdapter.scan(ctx(HOME, PROJECT));
    const skill = inventory.items.find((i) => i.id === 'cursor/skill:automate')!;
    expect(skill.description).toContain('Cursor Automations');
    expect(skill.tool).toBe('cursor');
    const ruleIds = inventory.items.filter((i) => i.kind === 'memory').map((i) => i.id).sort();
    expect(ruleIds).toEqual(['cursor/memory:rules:.cursorrules', 'cursor/memory:rules:style.mdc']);
  });
});
