import type { Axis, AxisWeights } from '../types.js';
import { AXES } from '../types.js';
import { heuristicClassify } from './heuristic.js';

/** What gets sent to the model per item — names/descriptions only, never transcripts (spec §7). */
export interface ClassifyInput {
  id: string;
  kind: string;
  name: string;
  description: string | null;
  /** First ~500 chars of a skill's body, when available. */
  body?: string;
}

/** Minimal injectable model surface so tests run offline. */
export interface ClassifyModel {
  complete(req: {
    system: string;
    user: string;
    schema: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface LlmItemResult {
  weights: AxisWeights;
  primary: Axis;
  summary: string;
  method: 'llm' | 'heuristic';
  flags?: string[];
}

export const BATCH_SIZE = 20;

/** Few-shot rubric — the spec's hand-labeled ambiguous cases anchor the axes (§4.3). */
export const RUBRIC = `You classify the components of an AI coding assistant setup (skills, subagents, MCP servers, hooks) onto five capability axes. For each item you receive its kind, name, description, and sometimes an excerpt of its body.

The five axes:
- engineering: writing, reviewing, debugging, refactoring, or testing code; APIs, databases, security analysis.
- writing: prose output — documentation, READMEs, changelogs, proposals, emails, notes, long-form text.
- research: finding and verifying information — web search, source gathering, investigation, exploring requirements or intent before building.
- design: visual and creative work — UI/UX, layout, styling, typography, graphics, animation.
- ops: automation and process — git/deploy workflows, CI, hooks, scheduling, monitoring, project/issue tracking, infrastructure.

Calibration examples (note the deliberately tricky ones):
- agent "doc-writer" (writes and updates documentation) → writing
- skill "git-workflow" (commit/branch/PR conventions) → ops, NOT engineering: it governs process, not code content
- agent "code-reviewer" (reviews code for quality and security) → engineering
- skill "deep-research" (fan-out web searches, verify claims, cited report) → research
- skill "frontend-design" (distinctive visual design, typography guidance) → design
- MCP server "grafana" (dashboards, monitoring) → ops
- agent "proposal-agent" (writes client proposals) → writing
- skill "brainstorming" (explore user intent and requirements before implementation) → research
- MCP server "notion" (notes and docs workspace) → writing
- hook "PostToolUse(Bash)" (automatically runs a shell command) → ops

For EVERY input item return: weights across all five axes summing to 1 (an item can genuinely span axes — e.g. 0.7 engineering / 0.3 ops), the primary axis (the one with the largest weight), and a one-line plain-English summary of what the item is for. Echo each item's id exactly as given in itemId.`;

const WEIGHT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [...AXES],
  properties: Object.fromEntries(AXES.map((axis) => [axis, { type: 'number' }])),
};

export const BATCH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['itemId', 'weights', 'primary', 'summary'],
        properties: {
          itemId: { type: 'string' },
          weights: WEIGHT_SCHEMA,
          primary: { type: 'string', enum: [...AXES] },
          summary: { type: 'string' },
        },
      },
    },
  },
};

/** Validate one model-returned entry: clamp, normalize, recompute primary. */
function parseEntry(
  raw: unknown,
): { weights: AxisWeights; primary: Axis; summary: string } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const rawWeights = record['weights'];
  if (typeof rawWeights !== 'object' || rawWeights === null) return null;
  const weightRecord = rawWeights as Record<string, unknown>;

  const weights = { engineering: 0, writing: 0, research: 0, design: 0, ops: 0 };
  let total = 0;
  for (const axis of AXES) {
    const value = weightRecord[axis];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    weights[axis] = Math.max(0, value);
    total += weights[axis];
  }
  if (total <= 0) return null;

  let primary: Axis = AXES[0];
  let best = -1;
  for (const axis of AXES) {
    weights[axis] /= total;
    if (weights[axis] > best) {
      best = weights[axis];
      primary = axis;
    }
  }

  const summary = record['summary'];
  if (typeof summary !== 'string' || summary === '') return null;
  return { weights, primary, summary };
}

function heuristicFallback(input: ClassifyInput): LlmItemResult {
  const h = heuristicClassify(input);
  return {
    weights: h.weights,
    primary: h.primary,
    summary: h.summary,
    method: 'heuristic',
    flags: [...(h.flags ?? []), 'llm-fallback'],
  };
}

export async function llmClassify(
  inputs: ClassifyInput[],
  model: ClassifyModel,
): Promise<Map<string, LlmItemResult>> {
  const results = new Map<string, LlmItemResult>();

  for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
    const batch = inputs.slice(start, start + BATCH_SIZE);
    let response: unknown = null;
    try {
      response = await model.complete({
        system: RUBRIC,
        user: JSON.stringify({ items: batch }),
        schema: BATCH_SCHEMA,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `agent-atlas: classification request failed (${message}); falling back to keyword heuristic for ${batch.length} items\n`,
      );
    }

    const byId = new Map<string, unknown>();
    if (typeof response === 'object' && response !== null) {
      const items = (response as Record<string, unknown>)['items'];
      if (Array.isArray(items)) {
        for (const entry of items) {
          if (typeof entry === 'object' && entry !== null) {
            const id = (entry as Record<string, unknown>)['itemId'];
            if (typeof id === 'string') byId.set(id, entry);
          }
        }
      }
    }

    for (const input of batch) {
      const parsed = parseEntry(byId.get(input.id));
      results.set(input.id, parsed !== null ? { ...parsed, method: 'llm' } : heuristicFallback(input));
    }
  }

  return results;
}
