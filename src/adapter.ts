import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { mineUsage } from './miner.js';
import { scan } from './scanner.js';
import type { AdapterContext, Inventory, Usage, UsageSupport } from './types.js';

/**
 * Per-tool adapter (SPEC_V2 §4.1): each AI coding tool implements this and
 * yields tool-agnostic JSON with tool-namespaced ids. The CLI runs detect()
 * on every registered adapter and scans only the ones that are present.
 */
export interface ToolAdapter {
  name: string;
  displayName: string;
  usageSupport: UsageSupport;
  detect(ctx: AdapterContext): Promise<boolean>;
  scan(ctx: AdapterContext): Promise<Inventory>;
  mineUsage(ctx: AdapterContext): Promise<Usage>;
}

export async function dirExists(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile();
  } catch {
    return false;
  }
}

export const claudeCodeAdapter: ToolAdapter = {
  name: 'claude-code',
  displayName: 'Claude Code',
  usageSupport: 'full',
  detect: (ctx) => dirExists(join(ctx.homeDir, '.claude')),
  scan: (ctx) => scan({ homeDir: ctx.homeDir, projectDir: ctx.projectDir }),
  mineUsage: (ctx) => mineUsage({ homeDir: ctx.homeDir, days: ctx.days, now: ctx.now }),
};

export const adapters: ToolAdapter[] = [claudeCodeAdapter];

export async function detectAdapters(ctx: AdapterContext): Promise<ToolAdapter[]> {
  const flags = await Promise.all(adapters.map((adapter) => adapter.detect(ctx)));
  return adapters.filter((_, i) => flags[i] === true);
}
