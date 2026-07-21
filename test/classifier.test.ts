import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { contentHash } from '../src/classifier/content.js';
import { classify } from '../src/classifier/index.js';
import type { ClassifyModel } from '../src/classifier/llm.js';
import { scan } from '../src/scanner.js';
import type { Inventory } from '../src/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOME = join(ROOT, 'fixtures', 'home');
const PROJECT = join(ROOT, 'fixtures', 'project');

const tmp = (): string => mkdtempSync(join(tmpdir(), 'agent-atlas-test-'));

/** Fake model that answers every item and counts what it was asked to classify. */
function countingModel(): ClassifyModel & { classifiedIds: string[]; callCount: number } {
  const state = { classifiedIds: [] as string[], callCount: 0 };
  return {
    get classifiedIds() {
      return state.classifiedIds;
    },
    get callCount() {
      return state.callCount;
    },
    async complete(req) {
      state.callCount++;
      const parsed = JSON.parse(req.user) as { items: Array<{ id: string }> };
      state.classifiedIds.push(...parsed.items.map((i) => i.id));
      return {
        items: parsed.items.map((i) => ({
          itemId: i.id,
          weights: { engineering: 0, writing: 0, research: 1, design: 0, ops: 0 },
          primary: 'research',
          summary: `Classified ${i.id}`,
        })),
      };
    },
  };
}

const syntheticInventory = (): Inventory => ({
  items: [
    {
      id: 'skill:alpha',
      kind: 'skill',
      name: 'alpha',
      description: 'Writes documentation.',
      sourcePath: '/nonexistent/alpha/SKILL.md',
      sizeBytes: 10,
    },
    {
      id: 'skill:beta',
      kind: 'skill',
      name: 'beta',
      description: 'Reviews code.',
      sourcePath: '/nonexistent/beta/SKILL.md',
      sizeBytes: 10,
    },
  ],
});

describe('classify (orchestrator)', () => {
  it('heuristic mode classifies everything except memory items, in inventory order', async () => {
    const inventory = await scan({ homeDir: HOME, projectDir: PROJECT });
    const output = await classify(inventory, { atlasDir: tmp(), model: null });

    expect(output.mode).toBe('heuristic');
    const classifiableIds = inventory.items.filter((i) => i.kind !== 'memory').map((i) => i.id);
    expect(output.items.map((i) => i.itemId)).toEqual(classifiableIds);
    for (const item of output.items) {
      expect(item.method === 'heuristic' || item.method === 'override').toBe(true);
      expect(item.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('llm mode caches by content hash — a second run makes zero model calls', async () => {
    const atlasDir = tmp();
    const inventory = syntheticInventory();

    const first = countingModel();
    const out1 = await classify(inventory, { atlasDir, model: first });
    expect(out1.mode).toBe('llm');
    expect(first.callCount).toBe(1);
    expect(first.classifiedIds.sort()).toEqual(['skill:alpha', 'skill:beta']);

    const second = countingModel();
    const out2 = await classify(inventory, { atlasDir, model: second });
    expect(second.callCount).toBe(0);
    expect(out2.items.find((i) => i.itemId === 'skill:alpha')!.method).toBe('llm');
    expect(out2.items.find((i) => i.itemId === 'skill:alpha')!.primary).toBe('research');
  });

  it('re-classifies only items whose content changed', async () => {
    const atlasDir = tmp();
    const inventory = syntheticInventory();
    await classify(inventory, { atlasDir, model: countingModel() });

    const changed = syntheticInventory();
    changed.items[1]!.description = 'Reviews code and deploys it.';
    const model = countingModel();
    await classify(changed, { atlasDir, model });

    expect(model.classifiedIds).toEqual(['skill:beta']);
  });

  it('overrides always win, over both strategies', async () => {
    const atlasDir = tmp();
    writeFileSync(
      join(atlasDir, 'overrides.json'),
      JSON.stringify({ 'skill:alpha': { primary: 'design', summary: 'Pinned.' } }),
    );

    const heuristic = await classify(syntheticInventory(), { atlasDir, model: null });
    const viaHeuristic = heuristic.items.find((i) => i.itemId === 'skill:alpha')!;
    expect(viaHeuristic.method).toBe('override');
    expect(viaHeuristic.primary).toBe('design');
    expect(viaHeuristic.weights.design).toBe(1);
    expect(viaHeuristic.summary).toBe('Pinned.');

    const llm = await classify(syntheticInventory(), { atlasDir, model: countingModel() });
    const viaLlm = llm.items.find((i) => i.itemId === 'skill:alpha')!;
    expect(viaLlm.method).toBe('override');
    expect(viaLlm.primary).toBe('design');
  });
});

describe('classify — privacy and warnings', () => {
  it('never sends hook items to the model — hooks classify heuristically', async () => {
    const inv: Inventory = {
      items: [
        ...syntheticInventory().items,
        {
          id: 'hook:PostToolUse:Bash',
          kind: 'hook',
          name: 'PostToolUse(Bash)',
          description: 'PostToolUse hook (Bash)',
          sourcePath: '/settings.json',
          sizeBytes: 60,
          event: 'PostToolUse',
          matcher: 'Bash',
          command: 'curl -H "Authorization: Bearer SECRET" https://hooks.example.com',
        },
      ],
    };
    const model = countingModel();
    const out = await classify(inv, { atlasDir: tmp(), model });

    expect(model.classifiedIds.sort()).toEqual(['skill:alpha', 'skill:beta']);
    const hook = out.items.find((i) => i.itemId === 'hook:PostToolUse:Bash')!;
    expect(hook.method).toBe('heuristic');
    expect(hook.primary).toBe('ops');
  });

  it('warns on stderr when an override matches no classified item', async () => {
    const atlasDir = tmp();
    writeFileSync(
      join(atlasDir, 'overrides.json'),
      JSON.stringify({ 'skill:does-not-exist': { primary: 'design' } }),
    );
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await classify(syntheticInventory(), { atlasDir, model: null });
      const written = spy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('skill:does-not-exist');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('contentHash', () => {
  it('is stable for identical content and changes when content changes', () => {
    const a = contentHash('alpha', 'Writes documentation.', '');
    const b = contentHash('alpha', 'Writes documentation.', '');
    const c = contentHash('alpha', 'Writes docs.', '');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
