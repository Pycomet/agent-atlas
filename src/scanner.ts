import type { Dirent } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join, sep } from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import type { Inventory, InventoryItem, McpTransport, ScanOptions } from './types.js';

// ---------- tolerant fs helpers (missing paths are fine — spec §4.1) ----------

async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await fs.stat(path)).size;
  } catch {
    return 0;
  }
}

async function readJsonSafe(path: string): Promise<Record<string, unknown> | null> {
  const text = await readFileSafe(path);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

// ---------- skills ----------

async function skillItem(skillPath: string, fallbackName: string, namePrefix = ''): Promise<InventoryItem | null> {
  const content = await readFileSafe(skillPath);
  if (content === null) return null;
  const fm = parseFrontmatter(content);
  const baseName = (!fm.malformed && fm.fields['name']) || fallbackName;
  const name = namePrefix + baseName;
  const description = fm.malformed ? null : fm.fields['description'] || null;
  const item: InventoryItem = {
    id: `skill:${name}`,
    kind: 'skill',
    name,
    description,
    sourcePath: skillPath,
    sizeBytes: await fileSize(skillPath),
  };
  if (fm.malformed) item.flags = ['invalid-frontmatter'];
  return item;
}

async function skillsFromDir(skillsDir: string, namePrefix = ''): Promise<InventoryItem[]> {
  const items: InventoryItem[] = [];
  for (const entry of await readDirSafe(skillsDir)) {
    if (!entry.isDirectory()) continue;
    const item = await skillItem(join(skillsDir, entry.name, 'SKILL.md'), entry.name, namePrefix);
    if (item !== null) items.push(item);
  }
  return items;
}

const SEMVER_LIKE = /^\d+(\.\d+){0,3}$/;

/**
 * The invocation prefix Claude Code uses is the plugin's manifest name — the
 * cache path is NOT authoritative (version dirs can be non-semver, e.g.
 * "unknown", which used to poison the prefix and break usage attribution).
 */
async function pluginNameFor(containerDir: string): Promise<string> {
  const manifest = await readJsonSafe(join(containerDir, '.claude-plugin', 'plugin.json'));
  const name = manifest?.['name'];
  if (typeof name === 'string' && name !== '') return name;
  const segments = containerDir.split(sep).filter(Boolean);
  let plugin = segments[segments.length - 1] ?? 'plugin';
  if (SEMVER_LIKE.test(plugin) && segments.length >= 2) {
    plugin = segments[segments.length - 2] ?? plugin;
  }
  return plugin;
}

/** `<plugin dir>/skills/<name>/SKILL.md` — plugin name from the manifest, path as fallback. */
async function pluginSkills(cacheDir: string): Promise<InventoryItem[]> {
  const items: InventoryItem[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) return;
    for (const entry of await readDirSafe(dir)) {
      if (!entry.isDirectory()) continue;
      // Plugin checkouts ship their own dev config (.claude/skills, .git, …) — never inventory it.
      if (entry.name.startsWith('.')) continue;
      const child = join(dir, entry.name);
      if (entry.name === 'skills') {
        const plugin = await pluginNameFor(dir);
        items.push(...(await skillsFromDir(child, `${plugin}:`)));
      } else {
        await walk(child, depth + 1);
      }
    }
  };
  await walk(cacheDir, 0);
  return items;
}

// ---------- agents ----------

async function agentsFromDir(agentsDir: string): Promise<InventoryItem[]> {
  const items: InventoryItem[] = [];
  for (const entry of await readDirSafe(agentsDir)) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const path = join(agentsDir, entry.name);
    const content = await readFileSafe(path);
    if (content === null) continue;
    const fm = parseFrontmatter(content);
    const name = (!fm.malformed && fm.fields['name']) || entry.name.replace(/\.md$/, '');
    const item: InventoryItem = {
      id: `agent:${name}`,
      kind: 'agent',
      name,
      description: fm.malformed ? null : fm.fields['description'] || null,
      sourcePath: path,
      sizeBytes: await fileSize(path),
    };
    if (fm.malformed) item.flags = ['invalid-frontmatter'];
    const tools = fm.fields['tools'];
    if (tools) {
      item.tools = tools
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    }
    items.push(item);
  }
  return items;
}

// ---------- MCP servers ----------

function transportOf(config: Record<string, unknown>): McpTransport {
  const type = config['type'];
  if (type === 'stdio' || type === 'sse' || type === 'http') return type;
  if (typeof config['command'] === 'string') return 'stdio';
  if (typeof config['url'] === 'string') return 'http';
  return 'unknown';
}

export function mcpItems(config: Record<string, unknown> | null, sourcePath: string): InventoryItem[] {
  const servers = asRecord(config?.['mcpServers']);
  if (servers === null) return [];
  const items: InventoryItem[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    const server = asRecord(raw);
    if (server === null) continue;
    items.push({
      id: `mcp:${name}`,
      kind: 'mcp',
      name,
      description: null,
      sourcePath,
      sizeBytes: Buffer.byteLength(JSON.stringify(server), 'utf8'),
      transport: transportOf(server),
    });
  }
  return items;
}

// ---------- hooks ----------

function hookItems(config: Record<string, unknown> | null, sourcePath: string): InventoryItem[] {
  const hooks = asRecord(config?.['hooks']);
  if (hooks === null) return [];
  const items: InventoryItem[] = [];
  for (const [event, entriesRaw] of Object.entries(hooks)) {
    if (!Array.isArray(entriesRaw)) continue;
    for (const entryRaw of entriesRaw) {
      const entry = asRecord(entryRaw);
      if (entry === null) continue;
      const matcher =
        typeof entry['matcher'] === 'string' && entry['matcher'] !== '' ? entry['matcher'] : '*';
      const inner = Array.isArray(entry['hooks']) ? entry['hooks'] : [];
      for (const hookRaw of inner) {
        const hook = asRecord(hookRaw);
        if (hook === null) continue;
        const command = typeof hook['command'] === 'string' ? hook['command'] : null;
        const item: InventoryItem = {
          id: `hook:${event}:${matcher}`,
          kind: 'hook',
          name: `${event}(${matcher})`,
          // Never the raw command: commands can hold secrets, and descriptions
          // are the one field that may leave the machine (classification API).
          description: `${event} hook (${matcher})`,
          sourcePath,
          sizeBytes: Buffer.byteLength(JSON.stringify(hook), 'utf8'),
          event,
          matcher,
        };
        if (command !== null) item.command = command;
        items.push(item);
      }
    }
  }
  return items;
}

// ---------- memory / context files ----------

async function memoryItem(path: string, scope: string): Promise<InventoryItem | null> {
  const size = await fileSize(path);
  const content = await readFileSafe(path);
  if (content === null) return null;
  return {
    id: `memory:${scope}:CLAUDE.md`,
    kind: 'memory',
    name: `CLAUDE.md (${scope})`,
    description: null,
    sourcePath: path,
    sizeBytes: size,
  };
}

// ---------- main ----------

export async function scan(opts: ScanOptions): Promise<Inventory> {
  const { homeDir, projectDir } = opts;
  const claudeDir = join(homeDir, '.claude');
  const items: InventoryItem[] = [];

  // Skills: user, project, plugin cache
  items.push(...(await skillsFromDir(join(claudeDir, 'skills'))));
  if (projectDir !== undefined) {
    items.push(...(await skillsFromDir(join(projectDir, '.claude', 'skills'))));
  }
  items.push(...(await pluginSkills(join(claudeDir, 'plugins', 'cache'))));

  // Agents: user + project
  items.push(...(await agentsFromDir(join(claudeDir, 'agents'))));
  if (projectDir !== undefined) {
    items.push(...(await agentsFromDir(join(projectDir, '.claude', 'agents'))));
  }

  // Config files (each read once)
  const homeClaudeJsonPath = join(homeDir, '.claude.json');
  const homeClaudeJson = await readJsonSafe(homeClaudeJsonPath);
  const homeSettingsPath = join(claudeDir, 'settings.json');
  const homeSettings = await readJsonSafe(homeSettingsPath);
  const projectLocalPath = projectDir ? join(projectDir, '.claude', 'settings.local.json') : null;
  const projectSettingsPath = projectDir ? join(projectDir, '.claude', 'settings.json') : null;
  const projectMcpPath = projectDir ? join(projectDir, '.mcp.json') : null;
  const projectLocal = projectLocalPath ? await readJsonSafe(projectLocalPath) : null;
  const projectSettings = projectSettingsPath ? await readJsonSafe(projectSettingsPath) : null;
  const projectMcp = projectMcpPath ? await readJsonSafe(projectMcpPath) : null;

  // MCP servers: first occurrence of a name wins, ordered most-specific first
  // (project local > project settings > project .mcp.json > user config).
  interface McpSource {
    config: Record<string, unknown> | null;
    path: string;
  }
  const mcpSources: McpSource[] = [];
  if (projectLocalPath !== null) mcpSources.push({ config: projectLocal, path: projectLocalPath });
  if (projectSettingsPath !== null)
    mcpSources.push({ config: projectSettings, path: projectSettingsPath });
  if (projectMcpPath !== null) mcpSources.push({ config: projectMcp, path: projectMcpPath });
  mcpSources.push({ config: homeClaudeJson, path: homeClaudeJsonPath });
  // ~/.claude.json also nests per-project servers under projects.<path>.mcpServers
  const nestedProjects = asRecord(homeClaudeJson?.['projects'] ?? null);
  if (nestedProjects !== null) {
    for (const nested of Object.values(nestedProjects)) {
      const record = asRecord(nested);
      if (record !== null) mcpSources.push({ config: record, path: homeClaudeJsonPath });
    }
  }
  mcpSources.push({ config: homeSettings, path: homeSettingsPath });

  const seenMcp = new Set<string>();
  for (const { config, path } of mcpSources) {
    if (config === null) continue;
    for (const item of mcpItems(config, path)) {
      if (seenMcp.has(item.name)) continue;
      seenMcp.add(item.name);
      items.push(item);
    }
  }

  // Hooks live in settings files only
  items.push(...hookItems(homeSettings, homeSettingsPath));
  if (projectSettingsPath !== null) items.push(...hookItems(projectSettings, projectSettingsPath));
  if (projectLocalPath !== null) items.push(...hookItems(projectLocal, projectLocalPath));

  // Memory files: counted as context load, not classified (spec §4.1)
  const userMemory = await memoryItem(join(claudeDir, 'CLAUDE.md'), 'user');
  if (userMemory !== null) items.push(userMemory);
  if (projectDir !== undefined) {
    const projectMemory = await memoryItem(join(projectDir, 'CLAUDE.md'), 'project');
    if (projectMemory !== null) items.push(projectMemory);
  }

  // Deterministic order + unique ids
  items.sort((a, b) =>
    a.kind === b.kind
      ? a.name < b.name
        ? -1
        : a.name > b.name
          ? 1
          : 0
      : a.kind < b.kind
        ? -1
        : 1,
  );
  const seenIds = new Map<string, number>();
  for (const item of items) {
    const n = (seenIds.get(item.id) ?? 0) + 1;
    seenIds.set(item.id, n);
    if (n > 1) item.id = `${item.id}#${n}`;
  }

  return { items };
}
