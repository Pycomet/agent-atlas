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

export interface MineOptions {
  homeDir: string;
  /** Usage window in days (default 30). */
  days?: number;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}
