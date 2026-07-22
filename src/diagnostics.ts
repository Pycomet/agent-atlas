import type { ClassifyModel } from './classifier/llm.js';
import type {
  Axis,
  ToolMeta,
  ClassificationOutput,
  DeadWeightFinding,
  DiagnosticsReport,
  GapFinding,
  Inventory,
  InventoryItem,
  OverlapFinding,
  Usage,
} from './types.js';
import { AXES } from './types.js';

export interface DiagnoseOptions {
  /** Optional LLM yes/no filter for overlap candidates. */
  model?: ClassifyModel | null;
  /** Tool roster — items of usage-less tools are excluded from dead weight (no data, no claim). */
  tools?: ToolMeta[];
  /** Per-tool session totals — token math multiplies by the owning tool's sessions, not the global sum. */
  sessionsByTool?: Record<string, number>;
}

const GAP_THRESHOLD = 0.05;
const COSINE_THRESHOLD = 0.9;
const JACCARD_THRESHOLD = 0.5;
const MAX_LLM_CANDIDATES = 40;

/* ---------- dead weight (§5.1) ---------- */

/**
 * Context-cost estimate for a never-used item. Spec §5 wants tool-schema
 * sizes for MCP servers, but schemas are only discoverable by connecting to
 * the server — off-limits for a read-only offline scanner. We estimate from
 * what we can see: name+description bytes for skills/agents (these sit in
 * every session's system prompt), config bytes as a stated LOWER BOUND for
 * MCP servers. Hooks occupy no context — no estimate.
 */
function contextEstimate(item: InventoryItem): {
  perSession: number | null;
  basis: DeadWeightFinding['estimateBasis'];
} {
  if (item.kind === 'skill' || item.kind === 'agent') {
    const bytes = Buffer.byteLength(`${item.name}: ${item.description ?? ''}`, 'utf8');
    return { perSession: Math.ceil(bytes / 4), basis: 'description' };
  }
  if (item.kind === 'mcp') {
    return { perSession: Math.ceil(item.sizeBytes / 4), basis: 'config-lower-bound' };
  }
  return { perSession: null, basis: null };
}

function deadWeightLine(
  item: InventoryItem,
  days: number,
  sessions: number,
  perSession: number | null,
  total: number | null,
  basis: DeadWeightFinding['estimateBasis'],
): string {
  const head = `\`${item.id}\`: never used in ${days} days`;
  if (perSession === null || total === null || sessions === 0) return `${head}.`;
  const qualifier = basis === 'config-lower-bound' ? 'at least ' : '';
  return `${head}, ${qualifier}~${perSession} tokens loaded into every one of your ${sessions} sessions (~${total} tokens total).`;
}

function findDeadWeight(
  inventory: Inventory,
  usage: Usage,
  days: number,
  tools?: ToolMeta[],
  sessionsByTool?: Record<string, number>,
): DeadWeightFinding[] {
  // "Never used" is only claimable for tools that actually have usage data.
  const usageless = new Set(
    (tools ?? []).filter((t) => t.usageSupport === 'none').map((t) => t.name),
  );
  const findings: DeadWeightFinding[] = [];
  for (const item of inventory.items) {
    if (item.kind === 'memory') continue;
    if (item.tool !== undefined && usageless.has(item.tool)) continue;
    if ((usage.items[item.id]?.count ?? 0) > 0) continue;
    const sessions =
      item.tool !== undefined && sessionsByTool?.[item.tool] !== undefined
        ? (sessionsByTool[item.tool] as number)
        : usage.totalSessions;
    const { perSession, basis } = contextEstimate(item);
    const total = perSession === null ? null : perSession * sessions;
    findings.push({
      itemId: item.id,
      kind: item.kind,
      sizeBytes: item.sizeBytes,
      estTokensPerSession: perSession,
      estTokensTotal: total,
      estimateBasis: basis,
      line: deadWeightLine(item, days, sessions, perSession, total, basis),
    });
  }
  return findings.sort((a, b) => {
    if (a.estTokensTotal === null && b.estTokensTotal === null)
      return a.itemId < b.itemId ? -1 : 1;
    if (a.estTokensTotal === null) return 1;
    if (b.estTokensTotal === null) return -1;
    return b.estTokensTotal - a.estTokensTotal || (a.itemId < b.itemId ? -1 : 1);
  });
}

/* ---------- overlaps (§5.2) ---------- */

const cosine = (a: Record<Axis, number>, b: Record<Axis, number>): number => {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const axis of AXES) {
    dot += a[axis] * b[axis];
    magA += a[axis] * a[axis];
    magB += b[axis] * b[axis];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
};

const tokenize = (text: string): Set<string> =>
  new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
};

/** Strip plugin prefixes so `feature-dev:code-reviewer` matches `code-reviewer`. */
const baseName = (name: string): string => name.slice(name.lastIndexOf(':') + 1);

function usageContrast(usage: Usage, aId: string, bId: string, days: number): string {
  const a = usage.items[aId]?.count ?? 0;
  const b = usage.items[bId]?.count ?? 0;
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  if (hi === 0) return `neither has been used in ${days} days`;
  if (lo === 0) return `you've used one ${hi}× and the other never`;
  return `you've used them ${hi}× and ${lo}×`;
}

interface OverlapCandidate {
  a: InventoryItem;
  b: InventoryItem;
  weightCosine: number;
}

async function llmOverlapFilter(
  candidates: OverlapCandidate[],
  model: ClassifyModel,
): Promise<boolean[] | null> {
  const schema: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['pairs'],
    properties: {
      pairs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['index', 'overlap'],
          properties: { index: { type: 'integer' }, overlap: { type: 'boolean' } },
        },
      },
    },
  };
  const user = JSON.stringify({
    pairs: candidates.map((c, index) => ({
      index,
      a: { name: c.a.name, kind: c.a.kind, description: c.a.description },
      b: { name: c.b.name, kind: c.b.kind, description: c.b.description },
    })),
  });
  const system =
    'You judge whether two components of an AI coding setup do essentially the same job. For each pair, answer overlap=true only when a user would plausibly keep just one of them. Different specialties, scopes, or workflows are NOT overlaps. Echo each index.';
  try {
    const response = await model.complete({ system, user, schema });
    if (typeof response !== 'object' || response === null) return null;
    const pairs = (response as Record<string, unknown>)['pairs'];
    if (!Array.isArray(pairs)) return null;
    const verdicts = candidates.map(() => false);
    for (const entry of pairs) {
      if (typeof entry !== 'object' || entry === null) continue;
      const rec = entry as Record<string, unknown>;
      if (typeof rec['index'] === 'number' && rec['index'] >= 0 && rec['index'] < verdicts.length) {
        verdicts[rec['index']] = rec['overlap'] === true;
      }
    }
    return verdicts;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `agent-atlas: overlap check call failed (${message}); keeping heuristic candidates\n`,
    );
    return null;
  }
}

async function findOverlaps(
  inventory: Inventory,
  usage: Usage,
  classification: ClassificationOutput,
  days: number,
  model: ClassifyModel | null,
): Promise<OverlapFinding[]> {
  const clsById = new Map(classification.items.map((c) => [c.itemId, c]));
  const items = inventory.items.filter((i) => clsById.has(i.id));

  const candidates: OverlapCandidate[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      const weightCosine = cosine(clsById.get(a.id)!.weights, clsById.get(b.id)!.weights);
      if (weightCosine < COSINE_THRESHOLD) continue;
      const nameSim = jaccard(tokenize(baseName(a.name)), tokenize(baseName(b.name)));
      const descSim =
        a.description !== null && b.description !== null
          ? jaccard(tokenize(a.description), tokenize(b.description))
          : 0;
      // Strictly greater: real duplicates score ~1.0; coincidental shared words land at exactly 0.5.
      if (nameSim <= JACCARD_THRESHOLD && descSim <= JACCARD_THRESHOLD) continue;
      candidates.push({ a, b, weightCosine });
    }
  }

  let kept = candidates.slice(0, MAX_LLM_CANDIDATES);
  let method: OverlapFinding['method'] = 'heuristic';
  if (model !== null && kept.length > 0) {
    const verdicts = await llmOverlapFilter(kept, model);
    if (verdicts !== null) {
      kept = kept.filter((_, index) => verdicts[index] === true);
      method = 'llm';
    }
  }

  return kept.map(({ a, b, weightCosine }) => ({
    itemIds: [a.id, b.id] as [string, string],
    weightCosine: Math.round(weightCosine * 1000) / 1000,
    method,
    line: `\`${a.name}\` and \`${b.name}\` appear to do the same job — ${usageContrast(usage, a.id, b.id, days)}.`,
  }));
}

/* ---------- gaps (§5.3) ---------- */

function findGaps(classification: ClassificationOutput): GapFinding[] {
  const items = classification.items;
  if (items.length === 0) return [];
  const gaps: GapFinding[] = [];
  for (const axis of AXES) {
    const share = items.reduce((sum, c) => sum + (c.weights[axis] || 0), 0) / items.length;
    if (share >= GAP_THRESHOLD) continue;
    const pct = Math.round(share * 1000) / 10;
    const line =
      share === 0
        ? `You have no ${axis}-oriented skills or agents. If you do ${axis} tasks, everything runs on the raw model.`
        : `Only ${pct}% of your installed capability is ${axis}. If you do ${axis} tasks, you're mostly running on the raw model.`;
    gaps.push({ axis, installedShare: Math.round(share * 10000) / 10000, line });
  }
  return gaps;
}

/* ---------- main ---------- */

export async function diagnose(
  inventory: Inventory,
  usage: Usage,
  classification: ClassificationOutput,
  days: number,
  opts: DiagnoseOptions = {},
): Promise<DiagnosticsReport> {
  return {
    deadWeight: findDeadWeight(inventory, usage, days, opts.tools, opts.sessionsByTool),
    overlaps: await findOverlaps(inventory, usage, classification, days, opts.model ?? null),
    gaps: findGaps(classification),
  };
}
