import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { classify } from '../src/classifier/index.js';
import type { ClassifyModel } from '../src/classifier/llm.js';
import { diagnose } from '../src/diagnostics.js';
import { mergeUsage, mineUsage } from '../src/miner.js';
import { scan } from '../src/scanner.js';
import type { ClassificationOutput, Inventory, Usage } from '../src/types.js';
import { AXES } from '../src/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOME = join(ROOT, 'fixtures', 'home');
const PROJECT = join(ROOT, 'fixtures', 'project');
const NOW = new Date('2026-07-21T00:00:00.000Z');

let inventory: Inventory;
let usage: Usage;
let classification: ClassificationOutput;

beforeAll(async () => {
  inventory = await scan({ homeDir: HOME, projectDir: PROJECT });
  usage = mergeUsage(inventory, await mineUsage({ homeDir: HOME, days: 30, now: NOW }));
  classification = await classify(inventory, {
    atlasDir: mkdtempSync(join(tmpdir(), 'agent-atlas-diag-test-')),
    model: null,
  });
});

describe('diagnose — dead weight (spec §5.1)', () => {
  it('lists never-used items with the token-cost estimate', async () => {
    const report = await diagnose(inventory, usage, classification, 30);
    const ids = report.deadWeight.map((f) => f.itemId);

    expect(ids).toContain('mcp:grafana');
    expect(ids).toContain('skill:deep-research');
    expect(ids).toContain('mcp:linear'); // only used outside the 30-day window
    expect(ids).not.toContain('skill:git-workflow'); // used 2x
    expect(ids).not.toContain('memory:user:CLAUDE.md'); // memory never diagnosed

    const grafana = report.deadWeight.find((f) => f.itemId === 'mcp:grafana')!;
    // config is 55 bytes -> ceil(55/4) = 14 tokens/session, x2 sessions = 28
    expect(grafana.estimateBasis).toBe('config-lower-bound');
    expect(grafana.estTokensPerSession).toBe(14);
    expect(grafana.estTokensTotal).toBe(28);
    expect(grafana.line).toContain('never used in 30 days');
    expect(grafana.line).toContain('~14');

    const hook = report.deadWeight.find((f) => f.itemId === 'hook:PostToolUse:Bash')!;
    expect(hook.estimateBasis).toBeNull();
    expect(hook.estTokensPerSession).toBeNull();
  });

  it('sorts by total estimated cost, highest first', async () => {
    const report = await diagnose(inventory, usage, classification, 30);
    const totals = report.deadWeight.map((f) => f.estTokensTotal ?? -1);
    const nonNull = totals.filter((t) => t >= 0);
    expect(nonNull).toEqual([...nonNull].sort((a, b) => b - a));
    // null-estimate findings come last
    const firstNull = totals.indexOf(-1);
    if (firstNull !== -1) {
      expect(totals.slice(firstNull).every((t) => t === -1)).toBe(true);
    }
  });
});

describe('diagnose — overlaps (spec §5.2)', () => {
  const overlapInventory: Inventory = {
    items: [
      {
        id: 'agent:code-reviewer',
        kind: 'agent',
        name: 'code-reviewer',
        description: 'Reviews code for quality, security, and maintainability.',
        sourcePath: '/a',
        sizeBytes: 100,
      },
      {
        id: 'agent:feature-dev:code-reviewer',
        kind: 'agent',
        name: 'feature-dev:code-reviewer',
        description: 'Reviews code for bugs, security issues, and code quality.',
        sourcePath: '/b',
        sizeBytes: 100,
      },
      {
        id: 'skill:deploy-checklist',
        kind: 'skill',
        name: 'deploy-checklist',
        description: 'Pre-deploy checklist for this project.',
        sourcePath: '/c',
        sizeBytes: 100,
      },
    ],
  };
  const overlapClassification: ClassificationOutput = {
    mode: 'heuristic',
    items: [
      {
        itemId: 'agent:code-reviewer',
        weights: { engineering: 1, writing: 0, research: 0, design: 0, ops: 0 },
        primary: 'engineering',
        summary: '',
        method: 'heuristic',
        contentHash: 'a',
      },
      {
        itemId: 'agent:feature-dev:code-reviewer',
        weights: { engineering: 0.9, writing: 0, research: 0.1, design: 0, ops: 0 },
        primary: 'engineering',
        summary: '',
        method: 'heuristic',
        contentHash: 'b',
      },
      {
        itemId: 'skill:deploy-checklist',
        weights: { engineering: 0, writing: 0, research: 0, design: 0, ops: 1 },
        primary: 'ops',
        summary: '',
        method: 'heuristic',
        contentHash: 'c',
      },
    ],
  };
  const overlapUsage: Usage = {
    totalSessions: 40,
    items: {
      'agent:code-reviewer': { count: 31, lastUsed: '2026-07-15T00:00:00.000Z', sessionsSeen: 20 },
      'agent:feature-dev:code-reviewer': { count: 0, lastUsed: null, sessionsSeen: 0 },
      'skill:deploy-checklist': { count: 2, lastUsed: '2026-07-15T00:00:00.000Z', sessionsSeen: 2 },
    },
  };

  it('pairs near-duplicates and contrasts their usage in the line', async () => {
    const report = await diagnose(overlapInventory, overlapUsage, overlapClassification, 30);
    expect(report.overlaps).toHaveLength(1);
    const pair = report.overlaps[0]!;
    expect(pair.itemIds.sort()).toEqual([
      'agent:code-reviewer',
      'agent:feature-dev:code-reviewer',
    ]);
    expect(pair.method).toBe('heuristic');
    expect(pair.line).toContain('31');
    expect(pair.line).toContain('never');
  });

  it('lets an LLM yes/no pass veto candidates when a model is provided', async () => {
    const vetoModel: ClassifyModel = {
      async complete(req) {
        const parsed = JSON.parse(req.user) as { pairs: Array<{ index: number }> };
        return { pairs: parsed.pairs.map((p) => ({ index: p.index, overlap: false })) };
      },
    };
    const report = await diagnose(overlapInventory, overlapUsage, overlapClassification, 30, {
      model: vetoModel,
    });
    expect(report.overlaps).toHaveLength(0);
  });

  it('finds no overlaps in the fixture tree', async () => {
    const report = await diagnose(inventory, usage, classification, 30);
    expect(report.overlaps).toEqual([]);
  });
});

describe('diagnose — gaps (spec §5.3)', () => {
  it('reports exactly the axes whose installed share is under 5%', async () => {
    const report = await diagnose(inventory, usage, classification, 30);
    const expectedGapAxes = AXES.filter(
      (axis) =>
        classification.items.reduce((sum, c) => sum + c.weights[axis], 0) /
          classification.items.length <
        0.05,
    );
    expect(report.gaps.map((g) => g.axis)).toEqual(expectedGapAxes);
    for (const gap of report.gaps) {
      expect(gap.installedShare).toBeLessThan(0.05);
      expect(gap.line.toLowerCase()).toContain(gap.axis);
    }
  });

  it('flags every missing axis with the spec wording on a lopsided setup', async () => {
    const lopsided: ClassificationOutput = {
      mode: 'heuristic',
      items: [
        {
          itemId: 'skill:only-code',
          weights: { engineering: 1, writing: 0, research: 0, design: 0, ops: 0 },
          primary: 'engineering',
          summary: '',
          method: 'heuristic',
          contentHash: 'x',
        },
      ],
    };
    const report = await diagnose(
      { items: [] },
      { totalSessions: 0, items: {} },
      lopsided,
      30,
    );
    expect(report.gaps.map((g) => g.axis)).toEqual(['writing', 'research', 'design', 'ops']);
    expect(report.gaps[0]!.line).toContain('no writing-oriented');
  });
});

describe('multi-tool dead weight honesty (v2)', () => {
  it('excludes usage-less tools and uses per-tool session counts', async () => {
    const inventory = {
      items: [
        { id: 'cursor/skill:sdk', kind: 'skill' as const, name: 'sdk', description: 'x', sourcePath: '/x', sizeBytes: 40, tool: 'cursor' },
        { id: 'claude-code/skill:unused', kind: 'skill' as const, name: 'unused', description: 'y', sourcePath: '/y', sizeBytes: 40, tool: 'claude-code' },
      ],
    };
    const usage = { totalSessions: 151, items: {} };
    const report = await diagnose(inventory, usage, { mode: 'heuristic' as const, items: [] }, 30, {
      tools: [
        { name: 'claude-code', displayName: 'Claude Code', detected: true, usageSupport: 'full', itemCount: 1 },
        { name: 'cursor', displayName: 'Cursor', detected: true, usageSupport: 'none', itemCount: 1 },
      ],
      sessionsByTool: { 'claude-code': 100, cursor: 0 },
    });
    const ids = report.deadWeight.map((f) => f.itemId);
    expect(ids).toContain('claude-code/skill:unused');
    expect(ids).not.toContain('cursor/skill:sdk');
    expect(report.deadWeight[0]!.line).toContain('100 sessions');
  });
});
