#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { Command } from 'commander';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { detectAdapters } from './adapter.js';
import { createAnthropicModel } from './classifier/anthropic-model.js';
import { classify } from './classifier/index.js';
import { diagnose } from './diagnostics.js';
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
  share?: boolean;
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
  .option('--share', 'render the map and highlight the shareable PNG card export')
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

    // One adapter per supported tool (SPEC_V2 §3); only detected tools scan.
    const ctx = { homeDir, projectDir: opts.project, days };
    const detected = await detectAdapters(ctx);
    const items: InventoryItem[] = [];
    let totalSessions = 0;
    const usageItems: Record<string, UsageEntry> = {};
    for (const adapter of detected) {
      const inv = await adapter.scan(ctx);
      items.push(...inv.items);
      const mined = await adapter.mineUsage(ctx);
      totalSessions += mined.totalSessions;
      Object.assign(usageItems, mined.items);
    }
    const inventory = { items };
    const usage: Usage = mergeUsage(inventory, { totalSessions, items: usageItems });

    const apiKey = process.env['ANTHROPIC_API_KEY'];
    const useLlm = opts.rough !== true && typeof apiKey === 'string' && apiKey !== '';
    const model = useLlm ? createAnthropicModel() : null;
    const classification = await classify(inventory, { atlasDir, model });
    const diagnostics = await diagnose(inventory, usage, classification, days, { model });

    if (opts.json === true) {
      process.stdout.write(
        `${JSON.stringify({ days, inventory, usage, classification, diagnostics }, null, 2)}\n`,
      );
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
      diagnostics,
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

    // Same weighted math as the map's installed tuning bar — the two must agree.
    const axisTotals = new Map<Axis, number>();
    for (const c of classification.items) {
      for (const axis of AXES) {
        axisTotals.set(axis, (axisTotals.get(axis) ?? 0) + (c.weights[axis] || 0));
      }
    }
    const classifiedTotal = Math.max(1, classification.items.length);
    const tuning = AXES.map((axis) => ({ axis, share: (axisTotals.get(axis) ?? 0) / classifiedTotal }))
      .filter(({ share }) => share >= 0.005)
      .sort((a, b) => b.share - a.share)
      .map(({ axis, share }) => `${axis} ${Math.round(100 * share)}%`)
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
    lines.push(`Never used in this window: ${neverUsed.length} items`);
    const topDead = diagnostics.deadWeight[0];
    if (topDead !== undefined) {
      const more = diagnostics.deadWeight.length - 1;
      lines.push(`Dead weight: ${topDead.line}${more > 0 ? ` (+${more} more in the page)` : ''}`);
    }
    if (diagnostics.overlaps.length > 0) {
      lines.push(`Overlaps: ${diagnostics.overlaps.length} suspected duplicate pair(s)`);
    }
    if (diagnostics.gaps.length > 0) {
      lines.push(`Gaps: no real coverage for ${diagnostics.gaps.map((g) => g.axis).join(', ')}`);
    }
    lines.push('');
    lines.push(`Map written to ${outPath}${shouldOpen ? ' (opening in browser)' : ''}`);
    if (opts.share === true) {
      lines.push("Share card: click the 'Share card' button in the page header to export the PNG.");
    }
    lines.push('Run with --json for the raw data.');
    process.stdout.write(`${lines.join('\n')}\n`);
  });

await program.parseAsync();
