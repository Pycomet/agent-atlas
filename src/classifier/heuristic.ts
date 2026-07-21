import type { Axis, AxisWeights } from '../types.js';
import { AXES } from '../types.js';

export interface HeuristicResult {
  weights: AxisWeights;
  primary: Axis;
  summary: string;
  flags?: string[];
}

/**
 * Rough-mode term lists (spec §6): keyword hits over name + description.
 * Tuned against fixtures/expected-classifications.json — the hand-labeled
 * regression set. Brand names (notion, grafana, …) are deliberate: MCP
 * servers often have no description, so the name is the only signal.
 */
const TERMS: Record<Axis, readonly string[]> = {
  engineering: [
    'code', 'coding', 'review', 'reviews', 'reviewer', 'debug', 'debugging', 'refactor',
    'refactoring', 'bug', 'bugs', 'typescript', 'javascript', 'python', 'api', 'sdk',
    'frontend', 'backend', 'database', 'sql', 'security', 'maintainability', 'test',
    'tests', 'testing', 'implementation', 'implement', 'compiler', 'github',
  ],
  writing: [
    'write', 'writes', 'writing', 'writer', 'written', 'documentation', 'doc', 'docs',
    'document', 'documents', 'readme', 'readmes', 'changelog', 'changelogs', 'proposal',
    'proposals', 'blog', 'email', 'emails', 'note', 'notes', 'notion', 'prose', 'summary',
    'summaries',
  ],
  research: [
    'research', 'explore', 'explores', 'exploring', 'search', 'searches', 'searching',
    'investigate', 'investigation', 'source', 'sources', 'cite', 'cited', 'citations',
    'verify', 'claims', 'intent', 'requirements', 'brainstorm', 'brainstorming', 'web',
    'fetch', 'learn', 'understand', 'analyze', 'analysis',
  ],
  design: [
    'design', 'designs', 'designer', 'ui', 'ux', 'visual', 'layout', 'css', 'styling',
    'aesthetic', 'aesthetics', 'creative', 'animation', 'animations', 'graphics', 'figma',
    'font', 'fonts', 'color', 'colors', 'artwork', 'illustration',
  ],
  ops: [
    'git', 'commit', 'commits', 'branch', 'branches', 'workflow', 'workflows', 'deploy',
    'deploys', 'deployment', 'release', 'releases', 'ci', 'pipeline', 'pipelines',
    'automation', 'automate', 'automated', 'cron', 'schedule', 'scheduled', 'monitor',
    'monitoring', 'hook', 'hooks', 'checklist', 'infra', 'infrastructure', 'devops',
    'docker', 'kubernetes', 'terraform', 'linear', 'jira', 'grafana', 'datadog', 'sentry',
    'log', 'logs', 'bash', 'shell', 'script', 'scripts', 'sh',
  ],
};

const TERM_SETS: ReadonlyArray<[Axis, Set<string>]> = AXES.map((axis) => [
  axis,
  new Set(TERMS[axis]),
]);

/** Hooks are automation by nature — small prior toward ops. */
const HOOK_OPS_PRIOR = 2;

const UNIFORM: AxisWeights = {
  engineering: 0.2,
  writing: 0.2,
  research: 0.2,
  design: 0.2,
  ops: 0.2,
};

export function heuristicClassify(item: {
  kind: string;
  name: string;
  description: string | null;
}): HeuristicResult {
  const text = `${item.name} ${item.description ?? ''}`.toLowerCase();
  const tokens = text.split(/[^a-z0-9]+/).filter(Boolean);

  const scores: AxisWeights = { engineering: 0, writing: 0, research: 0, design: 0, ops: 0 };
  for (const token of tokens) {
    for (const [axis, terms] of TERM_SETS) {
      if (terms.has(token)) scores[axis]++;
    }
  }
  if (item.kind === 'hook') scores.ops += HOOK_OPS_PRIOR;

  const total = AXES.reduce((sum, axis) => sum + scores[axis], 0);
  if (total === 0) {
    return {
      weights: { ...UNIFORM },
      primary: 'engineering',
      summary: `No keyword signal for "${item.name}" — low-confidence uniform classification.`,
      flags: ['low-confidence'],
    };
  }

  const weights = { ...scores };
  let primary: Axis = AXES[0];
  let best = -1;
  for (const axis of AXES) {
    weights[axis] = scores[axis] / total;
    if (weights[axis] > best) {
      best = weights[axis];
      primary = axis;
    }
  }

  return {
    weights,
    primary,
    summary: `Classified as ${primary} by keyword heuristic (${total} matching terms).`,
  };
}
