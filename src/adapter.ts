import { join } from 'node:path';
import { codexAdapter } from './adapters/codex.js';
import { dirExists, prefixInventory, prefixUsage } from './adapters/shared.js';
import { mineUsage } from './miner.js';
import { scan } from './scanner.js';
import type { AdapterContext, Inventory, Usage, UsageSupport } from './types.js';

export { dirExists, fileExists, prefixInventory, prefixUsage } from './adapters/shared.js';

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

export const claudeCodeAdapter: ToolAdapter = {
  name: 'claude-code',
  displayName: 'Claude Code',
  usageSupport: 'full',
  detect: (ctx) => dirExists(join(ctx.homeDir, '.claude')),
  scan: async (ctx) =>
    prefixInventory(await scan({ homeDir: ctx.homeDir, projectDir: ctx.projectDir }), 'claude-code'),
  mineUsage: async (ctx) =>
    prefixUsage(
      await mineUsage({ homeDir: ctx.homeDir, days: ctx.days, now: ctx.now }),
      'claude-code',
    ),
};

export const adapters: ToolAdapter[] = [claudeCodeAdapter, codexAdapter];

export async function detectAdapters(ctx: AdapterContext): Promise<ToolAdapter[]> {
  const flags = await Promise.all(adapters.map((adapter) => adapter.detect(ctx)));
  return adapters.filter((_, i) => flags[i] === true);
}
