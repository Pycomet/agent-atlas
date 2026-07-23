import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adapters, claudeCodeAdapter, detectAdapters, prefixInventory, prefixUsage } from '../src/adapter.js';
import { mineUsage } from '../src/miner.js';
import { scan } from '../src/scanner.js';
import type { AdapterContext } from '../src/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOME = join(ROOT, 'fixtures', 'home');
const PROJECT = join(ROOT, 'fixtures', 'project');
const NOW = new Date('2026-07-21T00:00:00.000Z');

const ctx = (homeDir: string): AdapterContext => ({
  homeDir,
  projectDir: PROJECT,
  days: 30,
  now: NOW,
});

describe('claudeCodeAdapter', () => {
  it('is registered under the name "claude-code"', () => {
    expect(claudeCodeAdapter.name).toBe('claude-code');
    expect(claudeCodeAdapter.displayName).toBe('Claude Code');
    expect(claudeCodeAdapter.usageSupport).toBe('full');
    expect(adapters).toContain(claudeCodeAdapter);
  });

  it('detects a home dir with .claude and rejects one without', async () => {
    expect(await claudeCodeAdapter.detect(ctx(HOME))).toBe(true);
    const emptyHome = mkdtempSync(join(tmpdir(), 'atlas-empty-'));
    expect(await claudeCodeAdapter.detect(ctx(emptyHome))).toBe(false);
  });

  it('scan() equals the direct scanner with claude-code/ prefixed ids', async () => {
    const viaAdapter = await claudeCodeAdapter.scan(ctx(HOME));
    const direct = await scan({ homeDir: HOME, projectDir: PROJECT });
    expect(viaAdapter).toEqual(prefixInventory(direct, 'claude-code'));
    for (const item of viaAdapter.items) {
      expect(item.id.startsWith('claude-code/')).toBe(true);
      expect(item.tool).toBe('claude-code');
    }
  });

  it('mineUsage() equals the direct miner with claude-code/ prefixed ids', async () => {
    const viaAdapter = await claudeCodeAdapter.mineUsage(ctx(HOME));
    const direct = await mineUsage({ homeDir: HOME, days: 30, now: NOW });
    expect(viaAdapter).toEqual(prefixUsage(direct, 'claude-code'));
  });
});

describe('detectAdapters', () => {
  it('returns only adapters whose tool is present', async () => {
    const detected = await detectAdapters(ctx(HOME));
    expect(detected.map((a) => a.name)).toContain('claude-code');
    const emptyHome = mkdtempSync(join(tmpdir(), 'atlas-empty-'));
    expect(await detectAdapters(ctx(emptyHome))).toEqual([]);
  });
});
