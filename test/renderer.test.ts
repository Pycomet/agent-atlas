import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { classify } from '../src/classifier/index.js';
import { crossToolDiagnose } from '../src/cross-tool.js';
import { diagnose } from '../src/diagnostics.js';
import { mergeUsage, mineUsage } from '../src/miner.js';
import { renderAtlas } from '../src/renderer/index.js';
import { scan } from '../src/scanner.js';
import type { AtlasData } from '../src/types.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOME = join(ROOT, 'fixtures', 'home');
const PROJECT = join(ROOT, 'fixtures', 'project');

let fixtureData: AtlasData;

const extractEmbedded = (html: string): unknown => {
  const match = /<script id="atlas-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  expect(match, 'embedded #atlas-data script missing').not.toBeNull();
  return JSON.parse(match![1]!);
};

beforeAll(async () => {
  const inventory = await scan({ homeDir: HOME, projectDir: PROJECT });
  const usage = mergeUsage(
    inventory,
    await mineUsage({ homeDir: HOME, days: 30, now: new Date('2026-07-21T00:00:00.000Z') }),
  );
  const classification = await classify(inventory, {
    atlasDir: mkdtempSync(join(tmpdir(), 'agent-atlas-render-test-')),
    model: null,
  });
  const diagnostics = await diagnose(inventory, usage, classification, 30);
  const toolsMeta = [
    {
      name: 'claude-code',
      displayName: 'Claude Code',
      detected: true,
      usageSupport: 'full' as const,
      itemCount: inventory.items.length,
    },
  ];
  const crossTool = crossToolDiagnose(inventory, usage, classification, toolsMeta);
  fixtureData = {
    generatedAt: '2026-07-21T00:00:00.000Z',
    days: 30,
    tools: toolsMeta,
    inventory,
    usage,
    classification,
    diagnostics,
    crossTool,
  };
});

describe('renderAtlas', () => {
  it('embeds the atlas data verbatim and recoverable', async () => {
    const html = await renderAtlas(fixtureData);
    expect(extractEmbedded(html)).toEqual(fixtureData);
  });

  it('is fully self-contained — no external src/href, d3 inlined', async () => {
    const html = await renderAtlas(fixtureData);
    expect(/(src|href)\s*=\s*["']https?:/i.test(html)).toBe(false);
    expect(html).toContain('d3js.org'); // d3.min.js banner — proof the library is inlined
    expect(html.length).toBeGreaterThan(200_000);
  });

  it('contains the map, tuning bar, detail panel, and filter controls', async () => {
    const html = await renderAtlas(fixtureData);
    for (const marker of ['id="map"', 'id="tuning-bar"', 'id="detail-panel"', 'id="filters"']) {
      expect(html).toContain(marker);
    }
  });

  it('contains the diagnostics section and the share-card button', async () => {
    const html = await renderAtlas(fixtureData);
    for (const marker of ['id="diagnostics"', 'id="diag-dead"', 'id="diag-overlaps"', 'id="diag-gaps"', 'id="share-btn"']) {
      expect(html).toContain(marker);
    }
    const embedded = extractEmbedded(html) as AtlasData;
    expect(embedded.diagnostics.deadWeight.length).toBeGreaterThan(0);
  });

  it('cannot be broken out of via a hostile item description', async () => {
    const hostile: AtlasData = JSON.parse(JSON.stringify(fixtureData)) as AtlasData;
    hostile.inventory.items[0]!.description = 'x</script><script>alert(1)</script>';
    const html = await renderAtlas(hostile);
    expect(html).not.toContain('x</script><script>alert(1)');
    const roundTripped = extractEmbedded(html) as AtlasData;
    expect(roundTripped.inventory.items[0]!.description).toBe(
      'x</script><script>alert(1)</script>',
    );
  });

  it('labels rough mode exactly when classification is heuristic', async () => {
    const roughHtml = await renderAtlas(fixtureData);
    expect(roughHtml.toLowerCase()).toContain('rough mode');

    const llmData: AtlasData = JSON.parse(JSON.stringify(fixtureData)) as AtlasData;
    llmData.classification.mode = 'llm';
    const llmHtml = await renderAtlas(llmData);
    expect(llmHtml.toLowerCase()).not.toContain('rough mode');
  });

  it('renders the tool filter container and embeds tools metadata', async () => {
    const html = await renderAtlas(fixtureData);
    expect(html).toContain('id="tool-filters"');
    expect(html).toContain('id="crosstool"');
    expect(html).toContain('id="toggle-bytool"');
    const embedded = extractEmbedded(html) as AtlasData;
    expect(embedded.tools[0]!.name).toBe('claude-code');
  });

  it('renders an empty inventory without throwing and with an empty state', async () => {
    const empty: AtlasData = {
      generatedAt: '2026-07-21T00:00:00.000Z',
      days: 30,
      tools: [],
      inventory: { items: [] },
      usage: { totalSessions: 0, items: {} },
      classification: { mode: 'heuristic', items: [] },
      diagnostics: { deadWeight: [], overlaps: [], gaps: [] },
      crossTool: { duplicates: [], imbalance: [], rulesOverlaps: [] },
    };
    const html = await renderAtlas(empty);
    expect(html).toContain('no tools detected');
    expect(html).toContain('tune-empty');
  });

  it('states the privacy posture in the page footer', async () => {
    const html = await renderAtlas(fixtureData);
    expect(html.toLowerCase()).toContain('read-only');
    expect(html.toLowerCase()).toContain('local');
  });
});
