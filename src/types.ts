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
  /** Owning tool (adapter name) — set by the adapter layer's id prefixing (SPEC_V2 §4.1). */
  tool?: string;
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

/** What an adapter can honestly report about invocation frequency (SPEC_V2 §3). */
export type UsageSupport = 'full' | 'partial' | 'none';

/** Everything an adapter needs to scan one machine (SPEC_V2 §4.1). */
export interface AdapterContext {
  homeDir: string;
  projectDir?: string;
  /** Usage window in days. */
  days: number;
  /** Injectable clock for deterministic tests. */
  now?: Date;
  /** Per-adapter config from ~/.agent-atlas/config.json, keyed by adapter name. */
  config?: Record<string, unknown>;
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

export interface DeadWeightFinding {
  itemId: string;
  kind: ItemKind;
  sizeBytes: number;
  /** Rough context cost (bytes ÷ 4); null when the item occupies no context (hooks). */
  estTokensPerSession: number | null;
  estTokensTotal: number | null;
  /** MCP figures are config-size lower bounds — real tool schemas are far larger (spec §5 deviation). */
  estimateBasis: 'description' | 'config-lower-bound' | null;
  line: string;
}

export interface OverlapFinding {
  itemIds: [string, string];
  weightCosine: number;
  method: 'heuristic' | 'llm';
  line: string;
}

export interface GapFinding {
  axis: Axis;
  installedShare: number;
  line: string;
}

export interface DiagnosticsReport {
  deadWeight: DeadWeightFinding[];
  overlaps: OverlapFinding[];
  gaps: GapFinding[];
}

/** Per-tool metadata surfaced in --json and embedded in atlas.html (SPEC_V2 §5). */
export interface ToolMeta {
  name: string;
  displayName: string;
  detected: boolean;
  usageSupport: UsageSupport;
  itemCount: number;
}

/** Everything the renderer embeds into atlas.html (spec §4.4). */
export interface AtlasData {
  generatedAt: string;
  days: number;
  tools: ToolMeta[];
  inventory: Inventory;
  usage: Usage;
  classification: ClassificationOutput;
  diagnostics: DiagnosticsReport;
}

export interface MineOptions {
  homeDir: string;
  /** Usage window in days (default 30). */
  days?: number;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}
