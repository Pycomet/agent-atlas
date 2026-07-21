import type {
  Axis,
  AxisWeights,
  Classification,
  ClassificationOutput,
  Inventory,
  InventoryItem,
} from '../types.js';
import { AXES } from '../types.js';
import { contentHash, readSkillBody } from './content.js';
import { heuristicClassify } from './heuristic.js';
import type { ClassifyInput, ClassifyModel, LlmItemResult } from './llm.js';
import { llmClassify } from './llm.js';
import { loadCache, loadOverrides, saveCache } from './store.js';

export interface ClassifyOptions {
  /** Root for cache.json + overrides.json (default ~/.agent-atlas). */
  atlasDir: string;
  /** LLM strategy when provided; null/undefined → heuristic rough mode (spec §6). */
  model?: ClassifyModel | null;
}

interface PreparedItem {
  item: InventoryItem;
  input: ClassifyInput;
  hash: string;
}

const oneHot = (primary: Axis): AxisWeights => {
  const weights = { engineering: 0, writing: 0, research: 0, design: 0, ops: 0 };
  weights[primary] = 1;
  return weights;
};

export async function classify(
  inventory: Inventory,
  opts: ClassifyOptions,
): Promise<ClassificationOutput> {
  // Memory files are context load, not capabilities — never classified (spec §4.1).
  const classifiable = inventory.items.filter((item) => item.kind !== 'memory');

  const prepared: PreparedItem[] = [];
  for (const item of classifiable) {
    const body = item.kind === 'skill' ? await readSkillBody(item.sourcePath) : '';
    const input: ClassifyInput = {
      id: item.id,
      kind: item.kind,
      name: item.name,
      description: item.description,
    };
    if (body !== '') input.body = body;
    prepared.push({ item, input, hash: contentHash(item.name, item.description, body) });
  }

  const model = opts.model ?? null;
  const results = new Map<string, Classification>();

  if (model !== null) {
    const cache = await loadCache(opts.atlasDir);
    const uncached = prepared.filter((entry) => cache[entry.hash] === undefined);
    const llmResults: Map<string, LlmItemResult> =
      uncached.length > 0
        ? await llmClassify(
            uncached.map((entry) => entry.input),
            model,
          )
        : new Map();

    let cacheDirty = false;
    for (const entry of prepared) {
      const hit = cache[entry.hash];
      if (hit !== undefined) {
        results.set(entry.item.id, {
          itemId: entry.item.id,
          weights: hit.weights,
          primary: hit.primary,
          summary: hit.summary,
          method: 'llm',
          contentHash: entry.hash,
        });
        continue;
      }
      const result = llmResults.get(entry.item.id);
      if (result === undefined) continue; // unreachable: llmClassify answers every input
      const classification: Classification = {
        itemId: entry.item.id,
        weights: result.weights,
        primary: result.primary,
        summary: result.summary,
        method: result.method,
        contentHash: entry.hash,
      };
      if (result.flags !== undefined && result.flags.length > 0) {
        classification.flags = result.flags;
      }
      results.set(entry.item.id, classification);
      // Only real LLM answers are cached — heuristic fallbacks retry next run.
      if (result.method === 'llm') {
        cache[entry.hash] = {
          weights: result.weights,
          primary: result.primary,
          summary: result.summary,
        };
        cacheDirty = true;
      }
    }
    if (cacheDirty) await saveCache(opts.atlasDir, cache);
  } else {
    for (const entry of prepared) {
      const h = heuristicClassify(entry.item);
      const classification: Classification = {
        itemId: entry.item.id,
        weights: h.weights,
        primary: h.primary,
        summary: h.summary,
        method: 'heuristic',
        contentHash: entry.hash,
      };
      if (h.flags !== undefined && h.flags.length > 0) classification.flags = h.flags;
      results.set(entry.item.id, classification);
    }
  }

  // Overrides always win (spec §4.3).
  const overrides = await loadOverrides(opts.atlasDir);
  for (const [itemId, override] of Object.entries(overrides)) {
    const existing = results.get(itemId);
    if (existing === undefined) continue;
    results.set(itemId, {
      itemId,
      weights: override.weights ?? oneHot(override.primary),
      primary: override.primary,
      summary: override.summary ?? `Pinned to ${override.primary} by user override.`,
      method: 'override',
      contentHash: existing.contentHash,
    });
  }

  return {
    mode: model !== null ? 'llm' : 'heuristic',
    items: classifiable.map((item) => results.get(item.id)).filter((c): c is Classification => c !== undefined),
  };
}

export { AXES };
export type { ClassifyModel };
