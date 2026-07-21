/** Kinds of items Agent Atlas tracks. Sorted alphabetically in output. */
export type ItemKind = 'agent' | 'hook' | 'mcp' | 'memory' | 'skill';

export type McpTransport = 'stdio' | 'sse' | 'http' | 'unknown';

export interface InventoryItem {
  id: string;
  kind: ItemKind;
  name: string;
  description: string | null;
  sourcePath: string;
  sizeBytes: number;
  /** e.g. ["invalid-frontmatter"] — item kept, never a crash (spec §4.1). */
  flags?: string[];
  /** Agents only: allowed tools from frontmatter. */
  tools?: string[];
  /** MCP servers only. */
  transport?: McpTransport;
  /** Hooks only. */
  event?: string;
  matcher?: string;
  command?: string;
}

export interface Inventory {
  items: InventoryItem[];
}

export interface UsageEntry {
  count: number;
  lastUsed: string | null;
  sessionsSeen: number;
}

export interface Usage {
  totalSessions: number;
  items: Record<string, UsageEntry>;
}

export interface ScanOptions {
  /** Directory treated as $HOME (contains .claude/ and .claude.json). */
  homeDir: string;
  /** Project directory to scan for .claude/, .mcp.json, CLAUDE.md. */
  projectDir?: string;
}

/** The five capability axes, fixed for v1 (spec §4.3). Order breaks ties. */
export const AXES = ['engineering', 'writing', 'research', 'design', 'ops'] as const;
export type Axis = (typeof AXES)[number];
export type AxisWeights = Record<Axis, number>;

export type ClassificationMethod = 'llm' | 'heuristic' | 'override';

export interface Classification {
  itemId: string;
  /** Sums to ~1. */
  weights: AxisWeights;
  primary: Axis;
  /** One plain-English line. */
  summary: string;
  method: ClassificationMethod;
  contentHash: string;
  /** e.g. ["low-confidence"], ["llm-fallback"] */
  flags?: string[];
}

export interface ClassificationOutput {
  /** Strategy used for non-overridden items; "heuristic" is rough mode (spec §6). */
  mode: 'llm' | 'heuristic';
  items: Classification[];
}

export interface MineOptions {
  homeDir: string;
  /** Usage window in days (default 30). */
  days?: number;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}
