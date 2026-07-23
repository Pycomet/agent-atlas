import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ToolAdapter } from '../adapter.js';
import { parseFrontmatter } from '../frontmatter.js';
import { mcpItems } from '../scanner.js';
import type { Inventory, InventoryItem } from '../types.js';
import {
  NO_USAGE,
  dirExists,
  fileExists,
  fileSize,
  prefixInventory,
  readFileSafe,
  readJsonSafe,
} from './shared.js';

/**
 * Cursor adapter (SPEC_V2 §3 Tier B — inventory-only). Verified 2026-07-22
 * on a real install: global `~/.cursor/mcp.json` + `~/.cursor/skills-cursor/
 * <name>/SKILL.md` (Claude-style frontmatter), project `.cursor/mcp.json`,
 * `.cursor/rules/*.mdc`, and `.cursorrules`. Cursor keeps no reliably
 * parseable local usage log, so usageSupport is 'none' — the renderer badges
 * these nodes instead of faking sizes.
 */

async function skillItems(skillsDir: string): Promise<InventoryItem[]> {
  const items: InventoryItem[] = [];
  let entries;
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return items;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(skillsDir, entry.name, 'SKILL.md');
    const content = await readFileSafe(path);
    if (content === null) continue;
    const fm = parseFrontmatter(content);
    const name = (!fm.malformed && fm.fields['name']) || entry.name;
    const item: InventoryItem = {
      id: `skill:${name}`,
      kind: 'skill',
      name,
      description: fm.malformed ? null : fm.fields['description'] || null,
      sourcePath: path,
      sizeBytes: await fileSize(path),
    };
    if (fm.malformed) item.flags = ['invalid-frontmatter'];
    items.push(item);
  }
  return items;
}

async function rulesItems(projectDir: string): Promise<InventoryItem[]> {
  const items: InventoryItem[] = [];

  const rulesDir = join(projectDir, '.cursor', 'rules');
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await fs.readdir(rulesDir, { withFileTypes: true });
  } catch {
    // no rules dir — fine
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.mdc')) continue;
    const path = join(rulesDir, entry.name);
    const content = await readFileSafe(path);
    if (content === null) continue;
    const fm = parseFrontmatter(content);
    items.push({
      id: `memory:rules:${entry.name}`,
      kind: 'memory',
      name: `.cursor/rules/${entry.name}`,
      description: fm.malformed ? null : fm.fields['description'] || null,
      sourcePath: path,
      sizeBytes: await fileSize(path),
    });
  }

  const legacyPath = join(projectDir, '.cursorrules');
  if (await fileExists(legacyPath)) {
    items.push({
      id: 'memory:rules:.cursorrules',
      kind: 'memory',
      name: '.cursorrules',
      description: null,
      sourcePath: legacyPath,
      sizeBytes: await fileSize(legacyPath),
    });
  }

  return items;
}

async function scanCursor(homeDir: string, projectDir?: string): Promise<Inventory> {
  const items: InventoryItem[] = [];

  // MCP servers: project config wins name collisions and keeps its attribution.
  const seen = new Set<string>();
  const sources: string[] = [];
  if (projectDir !== undefined) sources.push(join(projectDir, '.cursor', 'mcp.json'));
  sources.push(join(homeDir, '.cursor', 'mcp.json'));
  for (const source of sources) {
    const config = await readJsonSafe(source);
    if (config === null) continue;
    for (const item of mcpItems(config, source)) {
      if (seen.has(item.name)) continue;
      seen.add(item.name);
      items.push(item);
    }
  }

  items.push(...(await skillItems(join(homeDir, '.cursor', 'skills-cursor'))));
  if (projectDir !== undefined) items.push(...(await rulesItems(projectDir)));

  return { items };
}

export const cursorAdapter: ToolAdapter = {
  name: 'cursor',
  displayName: 'Cursor',
  usageSupport: 'none',
  detect: (ctx) => dirExists(join(ctx.homeDir, '.cursor')),
  scan: async (ctx) => prefixInventory(await scanCursor(ctx.homeDir, ctx.projectDir), 'cursor'),
  mineUsage: async () => NO_USAGE,
};
