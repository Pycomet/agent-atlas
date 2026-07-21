import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { adapters, claudeCodeAdapter } from '../src/adapter.js';
import { mineUsage } from '../src/miner.js';
import { scan } from '../src/scanner.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOME = join(ROOT, 'fixtures', 'home');
const PROJECT = join(ROOT, 'fixtures', 'project');
const NOW = new Date('2026-07-21T00:00:00.000Z');

describe('claudeCodeAdapter', () => {
  it('is registered under the name "claude-code"', () => {
    expect(claudeCodeAdapter.name).toBe('claude-code');
    expect(adapters).toContain(claudeCodeAdapter);
  });

  it('scan() is behavior-identical to the direct scanner', async () => {
    const viaAdapter = await claudeCodeAdapter.scan({ homeDir: HOME, projectDir: PROJECT });
    const direct = await scan({ homeDir: HOME, projectDir: PROJECT });
    expect(viaAdapter).toEqual(direct);
  });

  it('mineUsage() is behavior-identical to the direct miner', async () => {
    const viaAdapter = await claudeCodeAdapter.mineUsage({ homeDir: HOME, days: 30, now: NOW });
    const direct = await mineUsage({ homeDir: HOME, days: 30, now: NOW });
    expect(viaAdapter).toEqual(direct);
  });
});
