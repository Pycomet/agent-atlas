import { mineUsage } from './miner.js';
import { scan } from './scanner.js';
import type { Inventory, MineOptions, ScanOptions, Usage } from './types.js';

/**
 * Per-tool adapter (spec §2): each AI coding tool implements this pair and
 * yields tool-agnostic JSON. v1 ships Claude Code only; a CursorAdapter etc.
 * would be another entry in `adapters`.
 */
export interface ToolAdapter {
  name: string;
  scan(opts: ScanOptions): Promise<Inventory>;
  mineUsage(opts: MineOptions): Promise<Usage>;
}

export const claudeCodeAdapter: ToolAdapter = {
  name: 'claude-code',
  scan,
  mineUsage,
};

export const adapters: ToolAdapter[] = [claudeCodeAdapter];
