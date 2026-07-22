import { describe, expect, it } from 'vitest';
import { crossToolDiagnose } from '../src/cross-tool.js';
import type {
  ClassificationOutput,
  Inventory,
  InventoryItem,
  ToolMeta,
  Usage,
} from '../src/types.js';

const tool = (
  name: string,
  usageSupport: ToolMeta['usageSupport'] = 'full',
): ToolMeta => ({
  name,
  displayName: name === 'claude-code' ? 'Claude Code' : name === 'cursor' ? 'Cursor' : name,
  detected: true,
  usageSupport,
  itemCount: 0,
});

const mcp = (id: string, toolName: string, identity: string): InventoryItem => ({
  id,
  kind: 'mcp',
  name: id.split(':').pop() ?? id,
  description: null,
  sourcePath: '/x',
  sizeBytes: 10,
  tool: toolName,
  identity,
});

const weights = (primary: string): Record<string, number> => ({
  engineering: 0,
  writing: 0,
  research: 0,
  design: 0,
  ops: 0,
  [primary]: 1,
});

const noUsage: Usage = { totalSessions: 0, items: {} };
const emptyClassification: ClassificationOutput = { mode: 'heuristic', items: [] };

describe('crossToolDiagnose — duplicates', () => {
  const inventory: Inventory = {
    items: [
      mcp('claude-code/mcp:github', 'claude-code', 'cmd:npx -y @modelcontextprotocol/server-github'),
      mcp('cursor/mcp:github', 'cursor', 'cmd:npx -y @modelcontextprotocol/server-github'),
      mcp('claude-code/mcp:solo', 'claude-code', 'cmd:npx solo'),
    ],
  };

  it('flags the same MCP identity across two tools with a usage contrast', () => {
    const usage: Usage = {
      totalSessions: 5,
      items: { 'claude-code/mcp:github': { count: 9, lastUsed: null, sessionsSeen: 3 } },
    };
    const report = crossToolDiagnose(inventory, usage, emptyClassification, [
      tool('claude-code'),
      tool('cursor', 'none'),
    ]);
    expect(report.duplicates).toHaveLength(1);
    expect(report.duplicates[0]!.itemIds.sort()).toEqual([
      'claude-code/mcp:github',
      'cursor/mcp:github',
    ]);
    expect(report.duplicates[0]!.usedIn).toEqual(['claude-code']);
    expect(report.duplicates[0]!.line).toContain('only ever fires in Claude Code');
  });

  it('makes no usage claim when no owning tool has usage data', () => {
    const report = crossToolDiagnose(inventory, noUsage, emptyClassification, [
      tool('claude-code', 'none'),
      tool('cursor', 'none'),
    ]);
    expect(report.duplicates[0]!.line).not.toContain('fires');
    expect(report.duplicates[0]!.line).not.toContain('never fired');
  });

  it('never flags single-tool installs', () => {
    const single: Inventory = { items: [mcp('claude-code/mcp:solo', 'claude-code', 'cmd:x')] };
    const report = crossToolDiagnose(single, noUsage, emptyClassification, [tool('claude-code')]);
    expect(report.duplicates).toEqual([]);
  });
});

describe('crossToolDiagnose — capability imbalance', () => {
  const skill = (id: string, toolName: string): InventoryItem => ({
    id,
    kind: 'skill',
    name: id,
    description: null,
    sourcePath: '/x',
    sizeBytes: 10,
    tool: toolName,
  });

  it('flags an axis where one tool holds all the weight', () => {
    const inventory: Inventory = {
      items: [
        skill('claude-code/skill:research-1', 'claude-code'),
        skill('claude-code/skill:research-2', 'claude-code'),
        skill('cursor/skill:eng', 'cursor'),
      ],
    };
    const classification: ClassificationOutput = {
      mode: 'heuristic',
      items: [
        { itemId: 'claude-code/skill:research-1', weights: weights('research'), primary: 'research', summary: '', method: 'heuristic', contentHash: 'a' },
        { itemId: 'claude-code/skill:research-2', weights: weights('research'), primary: 'research', summary: '', method: 'heuristic', contentHash: 'b' },
        { itemId: 'cursor/skill:eng', weights: weights('engineering'), primary: 'engineering', summary: '', method: 'heuristic', contentHash: 'c' },
      ] as ClassificationOutput['items'],
    };
    const report = crossToolDiagnose(inventory, noUsage, classification, [
      tool('claude-code'),
      tool('cursor', 'none'),
    ]);
    const research = report.imbalance.find((f) => f.axis === 'research')!;
    expect(research.concentratedIn).toBe('claude-code');
    expect(research.line).toContain('All research capability lives in Claude Code');
  });

  it('stays silent with fewer than two classifiable tools', () => {
    const inventory: Inventory = { items: [skill('claude-code/skill:a', 'claude-code')] };
    const classification: ClassificationOutput = {
      mode: 'heuristic',
      items: [
        { itemId: 'claude-code/skill:a', weights: weights('research'), primary: 'research', summary: '', method: 'heuristic', contentHash: 'a' },
      ] as ClassificationOutput['items'],
    };
    const report = crossToolDiagnose(inventory, noUsage, classification, [tool('claude-code')]);
    expect(report.imbalance).toEqual([]);
  });
});

describe('crossToolDiagnose — rules overlaps', () => {
  const memory = (id: string, toolName: string, sourcePath: string): InventoryItem => ({
    id,
    kind: 'memory',
    name: sourcePath.split('/').pop() ?? id,
    description: null,
    sourcePath,
    sizeBytes: 10,
    tool: toolName,
  });

  it('flags instruction files across tools for human review', () => {
    const inventory: Inventory = {
      items: [
        memory('claude-code/memory:user:CLAUDE.md', 'claude-code', '/h/CLAUDE.md'),
        memory('cursor/memory:rules:.cursorrules', 'cursor', '/p/.cursorrules'),
      ],
    };
    const report = crossToolDiagnose(inventory, noUsage, emptyClassification, [
      tool('claude-code'),
      tool('cursor', 'none'),
    ]);
    expect(report.rulesOverlaps).toHaveLength(1);
    expect(report.rulesOverlaps[0]!.line).toContain('worth checking they agree');
  });

  it('stays silent when all rules files belong to one tool', () => {
    const inventory: Inventory = {
      items: [
        memory('claude-code/memory:user:CLAUDE.md', 'claude-code', '/h/CLAUDE.md'),
        memory('claude-code/memory:project:CLAUDE.md', 'claude-code', '/p/CLAUDE.md'),
      ],
    };
    const report = crossToolDiagnose(inventory, noUsage, emptyClassification, [tool('claude-code')]);
    expect(report.rulesOverlaps).toEqual([]);
  });
});
