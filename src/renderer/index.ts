import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AtlasData } from '../types.js';

const require = createRequire(import.meta.url);
const assetsDir = fileURLToPath(new URL('./assets/', import.meta.url));

/** d3's exports map hides dist/, so walk up from the entry to the package root. */
function d3MinPath(): string {
  let dir = dirname(require.resolve('d3'));
  while (basename(dir) !== 'd3' && dirname(dir) !== dir) dir = dirname(dir);
  return join(dir, 'dist', 'd3.min.js');
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Renders the single self-contained atlas.html (spec §4.4): D3 and all
 * assets inlined — no external requests, works offline, safe to share.
 */
export async function renderAtlas(data: AtlasData): Promise<string> {
  const [d3Source, appJs, css] = await Promise.all([
    fs.readFile(d3MinPath(), 'utf8'),
    fs.readFile(join(assetsDir, 'app.js'), 'utf8'),
    fs.readFile(join(assetsDir, 'style.css'), 'utf8'),
  ]);

  // `<` escaped so no item description can close the script tag (round-trips via JSON.parse).
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const rough = data.classification.mode === 'heuristic';
  const roughBadge = rough
    ? '<span class="badge-rough" title="Keyword-heuristic classification. Set ANTHROPIC_API_KEY and re-run for LLM-quality classification.">rough mode</span>'
    : '';
  const privacyNote = rough
    ? 'Read-only · local-only — nothing left this machine.'
    : 'Read-only · local-only — only item names/descriptions were sent to the classification API, never transcripts.';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Atlas</title>
<style>${css}</style>
</head>
<body>
<header class="topbar">
  <div class="wordmark">Agent <span class="wordmark-atlas">Atlas</span>
    <span class="wordmark-sub">${escapeHtml(data.tool)} · last ${data.days} days</span>
  </div>
  <div class="tuning">
    <div class="tuning-head">
      <span class="tuning-title">Tuning</span>
      <div class="seg-toggle">
        <button id="toggle-used" class="seg" type="button">used</button>
        <button id="toggle-installed" class="seg" type="button">installed</button>
      </div>
      ${roughBadge}
    </div>
    <div id="tuning-bar" aria-label="Capability tuning across the five axes"></div>
  </div>
</header>
<main id="stage">
  <svg id="map" role="img" aria-label="Force-directed map of installed capabilities"></svg>
  <aside id="filters" class="mapkey" aria-label="Legend and filters">
    <div class="mapkey-title">Legend</div>
    <div id="legend-axes"></div>
    <div class="mapkey-title">Kinds</div>
    <div id="kind-filters"></div>
    <label class="filter-row"><input type="checkbox" id="hide-unused"><span>hide never-used</span></label>
  </aside>
  <aside id="detail-panel" aria-live="polite" hidden></aside>
  <div id="tooltip" hidden></div>
</main>
<footer class="colophon">
  <span>${privacyNote}</span>
  <span>generated ${escapeHtml(data.generatedAt.slice(0, 10))} · agent-atlas</span>
</footer>
<script id="atlas-data" type="application/json">${json}</script>
<script>${d3Source}</script>
<script>${appJs}</script>
</body>
</html>
`;
}
