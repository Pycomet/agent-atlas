import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Axis, AxisWeights } from '../types.js';
import { AXES } from '../types.js';

export interface StoredClassification {
  weights: AxisWeights;
  primary: Axis;
  summary: string;
}

/** contentHash → classification. */
export type ClassificationCache = Record<string, StoredClassification>;

export interface OverrideEntry {
  primary: Axis;
  weights?: AxisWeights;
  summary?: string;
}

const isAxis = (value: unknown): value is Axis =>
  typeof value === 'string' && (AXES as readonly string[]).includes(value);

function parseWeights(raw: unknown): AxisWeights | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const weights = { engineering: 0, writing: 0, research: 0, design: 0, ops: 0 };
  for (const axis of AXES) {
    const value = record[axis];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    weights[axis] = value;
  }
  return weights;
}

async function readJsonSafe(path: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    process.stderr.write(`agent-atlas: ignoring corrupt JSON file at ${path}\n`);
    return null;
  }
}

export async function loadCache(atlasDir: string): Promise<ClassificationCache> {
  const raw = await readJsonSafe(join(atlasDir, 'cache.json'));
  if (raw === null) return {};
  const cache: ClassificationCache = {};
  for (const [hash, entryRaw] of Object.entries(raw)) {
    if (typeof entryRaw !== 'object' || entryRaw === null) continue;
    const entry = entryRaw as Record<string, unknown>;
    const weights = parseWeights(entry['weights']);
    if (weights === null || !isAxis(entry['primary']) || typeof entry['summary'] !== 'string') {
      continue;
    }
    cache[hash] = { weights, primary: entry['primary'], summary: entry['summary'] };
  }
  return cache;
}

export async function saveCache(atlasDir: string, cache: ClassificationCache): Promise<void> {
  await fs.mkdir(atlasDir, { recursive: true });
  await fs.writeFile(join(atlasDir, 'cache.json'), `${JSON.stringify(cache, null, 2)}\n`);
}

export async function loadOverrides(atlasDir: string): Promise<Record<string, OverrideEntry>> {
  const path = join(atlasDir, 'overrides.json');
  const raw = await readJsonSafe(path);
  if (raw === null) return {};
  const overrides: Record<string, OverrideEntry> = {};
  for (const [itemId, entryRaw] of Object.entries(raw)) {
    if (typeof entryRaw !== 'object' || entryRaw === null) continue;
    const entry = entryRaw as Record<string, unknown>;
    if (!isAxis(entry['primary'])) {
      process.stderr.write(
        `agent-atlas: ignoring override for "${itemId}" in ${path} — invalid primary axis\n`,
      );
      continue;
    }
    const override: OverrideEntry = { primary: entry['primary'] };
    const weights = parseWeights(entry['weights']);
    if (weights !== null) override.weights = weights;
    if (typeof entry['summary'] === 'string') override.summary = entry['summary'];
    overrides[itemId] = override;
  }
  return overrides;
}
