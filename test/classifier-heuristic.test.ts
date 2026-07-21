import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { heuristicClassify } from '../src/classifier/heuristic.js';
import { scan } from '../src/scanner.js';
import type { Axis } from '../src/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOME = join(ROOT, 'fixtures', 'home');
const PROJECT = join(ROOT, 'fixtures', 'project');

const expectedPrimaries = JSON.parse(
  readFileSync(join(ROOT, 'fixtures', 'expected-classifications.json'), 'utf8'),
) as Record<string, Axis>;

describe('heuristicClassify (rough mode)', () => {
  it('matches every hand-labeled fixture primary', async () => {
    const inventory = await scan({ homeDir: HOME, projectDir: PROJECT });
    for (const [id, expectedPrimary] of Object.entries(expectedPrimaries)) {
      const item = inventory.items.find((i) => i.id === id);
      expect(item, `fixture item ${id} missing from inventory`).toBeDefined();
      if (item === undefined) continue;
      const result = heuristicClassify(item);
      expect(result.primary, `primary for ${id}`).toBe(expectedPrimary);
    }
  });

  it('produces weights that sum to ~1 for every classifiable item', async () => {
    const inventory = await scan({ homeDir: HOME, projectDir: PROJECT });
    for (const item of inventory.items.filter((i) => i.kind !== 'memory')) {
      const result = heuristicClassify(item);
      const sum = Object.values(result.weights).reduce((a, b) => a + b, 0);
      expect(sum, `weights sum for ${item.id}`).toBeCloseTo(1, 5);
    }
  });

  it('falls back to uniform low-confidence weights when there is no signal', () => {
    const result = heuristicClassify({
      kind: 'skill',
      name: 'broken-skill',
      description: null,
    });
    expect(result.primary).toBe('engineering');
    expect(result.flags).toContain('low-confidence');
    expect(result.weights).toEqual({
      engineering: 0.2,
      writing: 0.2,
      research: 0.2,
      design: 0.2,
      ops: 0.2,
    });
  });

  it('writes a plain-English summary naming the primary axis', () => {
    const result = heuristicClassify({
      kind: 'skill',
      name: 'git-workflow',
      description: 'Git conventions for commits, branches, and pull requests.',
    });
    expect(result.summary.toLowerCase()).toContain('ops');
  });
});
