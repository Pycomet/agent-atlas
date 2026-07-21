#!/usr/bin/env node
import { Command } from 'commander';
import os from 'node:os';
import { mergeUsage, mineUsage } from './miner.js';
import { scan } from './scanner.js';

interface CliOptions {
  json?: boolean;
  days: string;
  home?: string;
  project: string;
}

const program = new Command();

program
  .name('agent-atlas')
  .description(
    'Scans your Claude Code setup (skills, agents, MCP servers, hooks) and mines usage from session transcripts. Read-only, local-only.',
  )
  .version('0.1.0')
  .option('--json', 'dump raw inventory + usage as JSON')
  .option('--days <n>', 'usage window in days', '30')
  .option('--home <dir>', 'treat <dir> as the home directory (mainly for testing)')
  .option('--project <dir>', 'project directory to scan', process.cwd())
  .action(async (opts: CliOptions) => {
    const days = Number.parseInt(opts.days, 10);
    if (!Number.isInteger(days) || days <= 0) {
      process.stderr.write('error: --days must be a positive integer\n');
      process.exitCode = 1;
      return;
    }
    const homeDir = opts.home ?? os.homedir();

    const inventory = await scan({ homeDir, projectDir: opts.project });
    const usage = mergeUsage(inventory, await mineUsage({ homeDir, days }));

    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify({ days, inventory, usage }, null, 2)}\n`);
      return;
    }

    const kindCounts = new Map<string, number>();
    for (const item of inventory.items) {
      kindCounts.set(item.kind, (kindCounts.get(item.kind) ?? 0) + 1);
    }
    const used = inventory.items
      .map((item) => ({ item, entry: usage.items[item.id] }))
      .filter(({ entry }) => (entry?.count ?? 0) > 0)
      .sort((a, b) => (b.entry?.count ?? 0) - (a.entry?.count ?? 0));
    const neverUsed = inventory.items.filter(
      (item) => item.kind !== 'memory' && (usage.items[item.id]?.count ?? 0) === 0,
    );

    const lines: string[] = [
      'Agent Atlas — scan complete (M1: inventory + usage)',
      '',
      `Inventory: ${inventory.items.length} items (${
        [...kindCounts].map(([kind, n]) => `${n} ${kind}`).join(', ') || 'none'
      })`,
      `Usage window: last ${days} days — ${usage.totalSessions} sessions`,
      '',
    ];
    if (used.length > 0) {
      lines.push('Most used:');
      for (const { item, entry } of used.slice(0, 10)) {
        lines.push(`  ${String(entry?.count ?? 0).padStart(4)}x  ${item.id}`);
      }
    } else {
      lines.push('No usage recorded in this window.');
    }
    lines.push(`Never used in this window: ${neverUsed.length} items`, '');
    lines.push('Run with --json for the full data. The map arrives in a later milestone.');
    process.stdout.write(`${lines.join('\n')}\n`);
  });

await program.parseAsync();
