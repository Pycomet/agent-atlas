import { promises as fs } from 'node:fs';
import type { Inventory, Usage } from '../types.js';

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

export async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function fileSize(path: string): Promise<number> {
  try {
    return (await fs.stat(path)).size;
  } catch {
    return 0;
  }
}

export async function readJsonSafe(path: string): Promise<Record<string, unknown> | null> {
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

/** Rewrite every item id to `<tool>/<id>` and stamp `item.tool` (SPEC_V2 §4.1). */
export function prefixInventory(inventory: Inventory, tool: string): Inventory {
  return {
    items: inventory.items.map((item) => ({ ...item, id: `${tool}/${item.id}`, tool })),
  };
}

/** Rewrite every usage id to `<tool>/<id>` (SPEC_V2 §4.1). */
export function prefixUsage(usage: Usage, tool: string): Usage {
  return {
    totalSessions: usage.totalSessions,
    items: Object.fromEntries(
      Object.entries(usage.items).map(([id, entry]) => [`${tool}/${id}`, entry]),
    ),
  };
}

export const NO_USAGE: Usage = { totalSessions: 0, items: {} };
