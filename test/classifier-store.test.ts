import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCache, loadOverrides, saveCache } from '../src/classifier/store.js';
import type { ClassificationCache } from '../src/classifier/store.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'agent-atlas-test-'));

const sample: ClassificationCache = {
  abc123: {
    weights: { engineering: 1, writing: 0, research: 0, design: 0, ops: 0 },
    primary: 'engineering',
    summary: 'A code tool.',
  },
};

describe('classification cache', () => {
  it('loads an empty cache when the file is missing', async () => {
    expect(await loadCache(join(tmp(), 'does-not-exist'))).toEqual({});
  });

  it('round-trips through save and load, creating the directory', async () => {
    const dir = join(tmp(), 'nested', 'atlas');
    await saveCache(dir, sample);
    expect(await loadCache(dir)).toEqual(sample);
    expect(JSON.parse(readFileSync(join(dir, 'cache.json'), 'utf8'))).toEqual(sample);
  });

  it('treats a corrupt cache file as empty', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'cache.json'), 'not json {{{');
    expect(await loadCache(dir)).toEqual({});
  });
});

describe('overrides', () => {
  it('loads an empty override set when the file is missing', async () => {
    expect(await loadOverrides(tmp())).toEqual({});
  });

  it('loads valid overrides and skips entries with an invalid primary', async () => {
    const dir = tmp();
    writeFileSync(
      join(dir, 'overrides.json'),
      JSON.stringify({
        'skill:git-workflow': { primary: 'design', summary: 'Pinned by user.' },
        'skill:bad': { primary: 'not-an-axis' },
      }),
    );
    const overrides = await loadOverrides(dir);
    expect(overrides['skill:git-workflow']).toEqual({
      primary: 'design',
      summary: 'Pinned by user.',
    });
    expect(overrides['skill:bad']).toBeUndefined();
  });

  it('treats a corrupt overrides file as empty', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'overrides.json'), '[not, valid');
    expect(await loadOverrides(dir)).toEqual({});
  });
});
