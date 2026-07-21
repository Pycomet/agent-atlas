import { describe, expect, it } from 'vitest';
import type { ClassifyInput, ClassifyModel } from '../src/classifier/llm.js';
import { BATCH_SIZE, llmClassify } from '../src/classifier/llm.js';
import { AXES } from '../src/types.js';

interface RecordedCall {
  system: string;
  user: string;
  schema: Record<string, unknown>;
}

/** Fake model: answers every item in the batch with the given per-id response. */
function fakeModel(
  respond: (ids: string[]) => unknown,
): ClassifyModel & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async complete(req) {
      calls.push(req);
      const parsed = JSON.parse(req.user) as { items: Array<{ id: string }> };
      return respond(parsed.items.map((i) => i.id));
    },
  };
}

const goodResponse = (ids: string[]): unknown => ({
  items: ids.map((id) => ({
    itemId: id,
    weights: { engineering: 1, writing: 0, research: 0, design: 0, ops: 0 },
    primary: 'engineering',
    summary: `Summary for ${id}`,
  })),
});

const input = (id: string, overrides: Partial<ClassifyInput> = {}): ClassifyInput => ({
  id,
  kind: 'skill',
  name: id.replace(/^skill:/, ''),
  description: 'Reviews code for quality.',
  ...overrides,
});

describe('llmClassify', () => {
  it('batches 20 items per request', async () => {
    const inputs = Array.from({ length: 45 }, (_, i) => input(`skill:item-${i}`));
    const model = fakeModel(goodResponse);
    const results = await llmClassify(inputs, model);

    expect(model.calls).toHaveLength(3);
    expect(results.size).toBe(45);
    const firstBatch = JSON.parse(model.calls[0]!.user) as { items: Array<{ id: string }> };
    expect(firstBatch.items).toHaveLength(BATCH_SIZE);
  });

  it('sends the rubric, item fields, and a strict schema', async () => {
    const model = fakeModel(goodResponse);
    await llmClassify(
      [input('skill:git-workflow', { description: 'Git conventions.', body: 'Use commits.' })],
      model,
    );

    const call = model.calls[0]!;
    for (const axis of AXES) {
      expect(call.system).toContain(axis);
    }
    expect(call.user).toContain('git-workflow');
    expect(call.user).toContain('Git conventions.');
    expect(call.user).toContain('Use commits.');
    expect(call.schema['additionalProperties']).toBe(false);
  });

  it('normalizes weights and recomputes primary from them', async () => {
    const model = fakeModel((ids) => ({
      items: ids.map((id) => ({
        itemId: id,
        // Unnormalized, and primary lies — argmax is engineering.
        weights: { engineering: 2, writing: 1, research: 1, design: 0, ops: 0 },
        primary: 'ops',
        summary: 'A tool.',
      })),
    }));
    const results = await llmClassify([input('skill:x')], model);
    const r = results.get('skill:x')!;

    expect(r.method).toBe('llm');
    expect(r.primary).toBe('engineering');
    expect(r.weights.engineering).toBeCloseTo(0.5, 5);
    expect(r.weights.writing).toBeCloseTo(0.25, 5);
    expect(Object.values(r.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });

  it('falls back to the heuristic for items missing or invalid in the response', async () => {
    const model = fakeModel((ids) => ({
      items: ids
        .filter((id) => id !== 'skill:dropped')
        .map((id) => ({
          itemId: id,
          weights: { engineering: 1, writing: 0, research: 0, design: 0, ops: 0 },
          primary: 'engineering',
          summary: 'ok',
        })),
    }));
    const results = await llmClassify([input('skill:kept'), input('skill:dropped')], model);

    expect(results.get('skill:kept')!.method).toBe('llm');
    const dropped = results.get('skill:dropped')!;
    expect(dropped.method).toBe('heuristic');
    expect(dropped.flags).toContain('llm-fallback');
  });

  it('falls back to the heuristic for the whole batch when the model call throws', async () => {
    const model: ClassifyModel = {
      async complete() {
        throw new Error('rate limited');
      },
    };
    const results = await llmClassify([input('skill:a'), input('skill:b')], model);

    expect(results.size).toBe(2);
    for (const id of ['skill:a', 'skill:b']) {
      const r = results.get(id)!;
      expect(r.method).toBe('heuristic');
      expect(r.flags).toContain('llm-fallback');
    }
  });
});
