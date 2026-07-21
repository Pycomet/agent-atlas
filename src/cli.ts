#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { Command } from 'commander';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { adapters } from './adapter.js';
import { createAnthropicModel } from './classifier/anthropic-model.js';
import { classify } from './classifier/index.js';
import { mergeUsage } from './miner.js';
import { renderAtlas } from './renderer/index.js';
import type { Axis, InventoryItem, Usage, UsageEntry } from './types.js';
import { AXES } from './types.js';

interface CliOptions {
  json?: boolean;
  days: string;
  home?: string;
  project: string;
  rough?: boolean;
  atlasDir?: string;
  out: string;
  open: boolean;
}

/** Best-effort browser launch — never fails the run, never blocks exit. */
function openInBrowser(path: string): void {
  const launcher = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(launcher, [path], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Fine — the path is printed; the user can open it themselves.
  }
}

const program = new Command();

program
  .name('agent-atlas')
  .description(
    'Scans your Claude Code setup (skills, agents, MCP servers, hooks) and mines usage from session transcripts. Read-only, local-only; only item names/descriptions are sent to the classification API.',
  )
  .version('0.1.0')
  .option('--json', 'dump raw inventory + usage + classification as JSON')
  .option('--days <n>', 'usage window in days', '30')
  .option('--rough', 'force keyword-heuristic classification (skip the API)')
  .option('--atlas-dir <dir>', 'directory for classification cache and overrides.json')
  .option('--out <file>', 'where to write atlas.html', './atlas.html')
  .option('--no-open', 'do not open atlas.html in the browser')
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
    const atlasDir = opts.atlasDir ?? join(os.homedir(), '.agent-atlas');

    // One adapter per supported tool (spec §2) — v1 ships Claude Code only.
    const items: InventoryItem[] = [];
    let totalSessions = 0;
    const usageItems: Record<string, UsageEntry> = {};
    for (const adapter of adapters) {
      const inv = await adapter.scan({ homeDir, projectDir: opts.project });
      items.push(...inv.items);
      const mined = await adapter.mineUsage({ homeDir, days });
      totalSessions += mined.totalSessions;
      Object.assign(usageItems, mined.items);
    }
    const inventory = { items };
    const usage: Usage = mergeUsage(inventory, { totalSessions, items: usageItems });

    const apiKey = process.env['ANTHROPIC_API_KEY'];
    const useLlm = opts.rough !== true && typeof apiKey === 'string' && apiKey !== '';
    const classification = await classify(inventory, {
      atlasDir,
      model: useLlm ? createAnthropicModel() : null,
    });

    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify({ days, inventory, usage, classification }, null, 2)}\n`);
      return;
    }

    // Default flow (spec §3): write the self-contained map and open it.
    const html = await renderAtlas({
      generatedAt: new Date().toISOString(),
      days,
      tool: 'claude-code',
      inventory,
      usage,
      classification,
    });
    const outPath = resolve(opts.out);
    await fs.writeFile(outPath, html);
    const shouldOpen = opts.open && process.env['CI'] === undefined;
    if (shouldOpen) openInBrowser(outPath);

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

    const axisCounts = new Map<Axis, number>();
    for (const c of classification.items) {
      axisCounts.set(c.primary, (axisCounts.get(c.primary) ?? 0) + 1);
    }
    const classifiedTotal = classification.items.length;
    const tuning = AXES.map((axis) => ({ axis, n: axisCounts.get(axis) ?? 0 }))
      .filter(({ n }) => n > 0)
      .sort((a, b) => b.n - a.n)
      .map(({ axis, n }) => `${axis} ${Math.round((100 * n) / Math.max(1, classifiedTotal))}%`)
      .join(' · ');

    const lines: string[] = [
      'Agent Atlas — scan complete (inventory + usage + classification)',
      '',
      `Inventory: ${inventory.items.length} items (${
        [...kindCounts].map(([kind, n]) => `${n} ${kind}`).join(', ') || 'none'
      })`,
      `Usage window: last ${days} days — ${usage.totalSessions} sessions`,
      `Tuning (installed): ${tuning || 'nothing classifiable'}${
        classification.mode === 'heuristic'
          ? '\n  [rough mode — keyword heuristic; set ANTHROPIC_API_KEY for LLM classification]'
          : ''
      }`,
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
    lines.push(`Map written to ${outPath}${shouldOpen ? ' (opening in browser)' : ''}`);
    lines.push('Run with --json for the raw data.');
    process.stdout.write(`${lines.join('\n')}\n`);
  });

await program.parseAsync();
