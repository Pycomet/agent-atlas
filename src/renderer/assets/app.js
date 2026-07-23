/* Agent Atlas client. All user-derived strings rendered via textContent — never innerHTML. */
(() => {
  'use strict';
  /* global d3 */

  const data = JSON.parse(document.getElementById('atlas-data').textContent);
  const AXES = ['engineering', 'writing', 'research', 'design', 'ops'];
  const AXIS_COLOR = {
    engineering: '#3987e5',
    writing: '#d95926',
    research: '#199e70',
    design: '#e87ba4',
    ops: '#e29900',
  };
  const DEAD = '#414b5e';
  const SURFACE = '#10141d';
  /* Tool badge palette — assigned by roster order, stable across runs. */
  const TOOL_COLORS = ['#8a93a6', '#5ec8d8', '#c98bdb', '#7dd487', '#e0b566', '#d88a8a'];
  const toolList = data.tools || [];
  const toolMeta = new Map(toolList.map((t, i) => [t.name, { ...t, color: TOOL_COLORS[i % TOOL_COLORS.length] }]));
  const noUsageTool = (n) => {
    const meta = toolMeta.get(n.item.tool);
    return meta !== undefined && meta.usageSupport === 'none';
  };
  const SYMBOLS = {
    skill: d3.symbolCircle,
    agent: d3.symbolSquare,
    mcp: d3.symbolDiamond,
    hook: d3.symbolTriangle,
  };
  const KIND_GLYPH = { skill: '●', agent: '■', mcp: '◆', hook: '▲' };

  const clsById = new Map(data.classification.items.map((c) => [c.itemId, c]));
  const nodes = data.inventory.items
    .filter((item) => clsById.has(item.id))
    .map((item) => {
      const usage = data.usage.items[item.id] || { count: 0, lastUsed: null, sessionsSeen: 0 };
      const meta = toolMeta.get(item.tool);
      const usageless = meta !== undefined && meta.usageSupport === 'none';
      return {
        id: item.id,
        item,
        usage,
        cls: clsById.get(item.id),
        // Usage-less tools render at a fixed size: node size means "how often
        // used", and we refuse to fake that signal (SPEC_V2 §4.4).
        r: usageless ? 9 : 7 + 4 * Math.log2(usage.count + 1),
      };
    });

  /* ---------- tuning bar ---------- */
  function tuningShares(mode, subset) {
    const totals = Object.fromEntries(AXES.map((a) => [a, 0]));
    let denom = 0;
    for (const n of subset || nodes) {
      const w = mode === 'used' ? n.usage.count : 1;
      if (w === 0) continue;
      denom += w;
      for (const a of AXES) totals[a] += (n.cls.weights[a] || 0) * w;
    }
    return denom === 0 ? null : AXES.map((a) => ({ axis: a, share: totals[a] / denom }));
  }

  function segRow(shares, container) {
    for (const { axis, share } of shares) {
      if (share < 0.005) continue;
      const seg = document.createElement('div');
      seg.className = 'tune-seg';
      seg.style.flexGrow = String(Math.max(share, 0.02));
      seg.style.background = AXIS_COLOR[axis];
      seg.title = axis + ' ' + Math.round(share * 100) + '%';
      const lbl = document.createElement('span');
      lbl.className = 'tune-lbl';
      lbl.textContent = axis + ' ' + Math.round(share * 100) + '%';
      seg.appendChild(lbl);
      container.appendChild(seg);
    }
  }

  /* Per-tool mini bars — "Cursor is all engineering, Claude Code carries the
     writing" in one glance (SPEC_V2 §4.4). Installed weights: usage-less
     tools must render honestly here too. */
  function renderTuningByTool() {
    const bar = document.getElementById('tuning-bar');
    bar.textContent = '';
    bar.classList.add('by-tool');
    const present = [...new Set(nodes.map((n) => n.item.tool).filter(Boolean))];
    for (const toolName of present) {
      const subset = nodes.filter((n) => n.item.tool === toolName);
      const shares = tuningShares('installed', subset);
      if (shares === null) continue;
      const row = document.createElement('div');
      row.className = 'tune-tool-row';
      const meta = toolMeta.get(toolName);
      const label = document.createElement('span');
      label.className = 'tune-tool-label';
      label.style.color = meta !== undefined ? meta.color : '#8a93a6';
      label.textContent = meta !== undefined ? meta.displayName : toolName;
      const mini = document.createElement('div');
      mini.className = 'tune-mini';
      segRow(shares, mini);
      row.append(label, mini);
      bar.appendChild(row);
    }
  }

  function renderTuning(mode) {
    const bar = document.getElementById('tuning-bar');
    bar.classList.remove('by-tool');
    bar.textContent = '';
    if (mode === 'bytool') {
      renderTuningByTool();
      return;
    }
    // Empty setup: both modes yield null — render an empty state, never throw
    // (an exception here would kill the whole page script).
    const shares = tuningShares(mode) || tuningShares('installed') || [];
    if (shares.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'tune-empty';
      empty.textContent = 'nothing classifiable yet — install a skill or agent and re-run';
      bar.appendChild(empty);
      return;
    }
    segRow(shares, bar);
  }

  const totalUse = nodes.reduce((s, n) => s + n.usage.count, 0);
  const btnUsed = document.getElementById('toggle-used');
  const btnInstalled = document.getElementById('toggle-installed');
  const btnByTool = document.getElementById('toggle-bytool');
  let tuneMode = 'used';
  if (totalUse === 0) {
    btnUsed.disabled = true;
    btnUsed.title = 'No usage recorded in this window';
    tuneMode = 'installed';
  }
  function setTuneMode(mode) {
    tuneMode = mode;
    btnUsed.classList.toggle('on', mode === 'used');
    btnInstalled.classList.toggle('on', mode === 'installed');
    if (btnByTool !== null) btnByTool.classList.toggle('on', mode === 'bytool');
    renderTuning(mode);
  }
  btnUsed.addEventListener('click', () => setTuneMode('used'));
  btnInstalled.addEventListener('click', () => setTuneMode('installed'));
  if (btnByTool !== null) {
    const multiTool = [...new Set(nodes.map((n) => n.item.tool).filter(Boolean))].length > 1;
    if (multiTool) btnByTool.addEventListener('click', () => setTuneMode('bytool'));
    else btnByTool.hidden = true;
  }
  setTuneMode(tuneMode);

  /* ---------- map ---------- */
  const svg = d3.select('#map');
  const W = 1600;
  const H = 1000;
  svg.attr('viewBox', '0 0 ' + W + ' ' + H).attr('preserveAspectRatio', 'xMidYMid meet');
  const cx = W / 2;
  const cy = H / 2 + 14;
  const R = Math.min(W, H) * 0.3;
  const hubPos = {};
  AXES.forEach((a, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / AXES.length;
    hubPos[a] = { x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle) };
  });
  nodes.forEach((n, i) => {
    const h = hubPos[n.cls.primary];
    const jitter = 40 + (i % 7) * 14;
    n.x = h.x + Math.cos(i * 2.4) * jitter;
    n.y = h.y + Math.sin(i * 2.4) * jitter;
  });

  const gLinks = svg.append('g');
  const gHubs = svg.append('g');
  const gNodes = svg.append('g');

  const linkSel = gLinks
    .selectAll('line.hub')
    .data(nodes)
    .join('line')
    .attr('class', 'hub')
    .attr('stroke', (n) => AXIS_COLOR[n.cls.primary])
    .attr('stroke-opacity', 0.13)
    .attr('stroke-width', 1);

  // Dashed edges between suspected-duplicate pairs (spec §4.4)
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const overlapPairs = data.diagnostics.overlaps
    .map((o) => ({ a: nodeById.get(o.itemIds[0]), b: nodeById.get(o.itemIds[1]) }))
    .filter((p) => p.a && p.b);
  const overlapSel = gLinks
    .selectAll('line.overlap')
    .data(overlapPairs)
    .join('line')
    .attr('class', 'overlap')
    .attr('stroke', '#a9b2c3')
    .attr('stroke-opacity', 0.55)
    .attr('stroke-width', 1.2)
    .attr('stroke-dasharray', '5 4');

  for (const a of AXES) {
    const h = hubPos[a];
    gHubs
      .append('circle')
      .attr('cx', h.x)
      .attr('cy', h.y)
      .attr('r', 24)
      .attr('fill', 'none')
      .attr('stroke', AXIS_COLOR[a])
      .attr('stroke-opacity', 0.55)
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', '1 5')
      .attr('stroke-linecap', 'round');
    gHubs.append('circle').attr('cx', h.x).attr('cy', h.y).attr('r', 3.5).attr('fill', AXIS_COLOR[a]);
    gHubs
      .append('text')
      .attr('x', h.x)
      .attr('y', h.y - 36)
      .attr('class', 'hub-label')
      .attr('fill', AXIS_COLOR[a])
      .text(a.toUpperCase());
  }

  const symbol = d3.symbol();
  const nodeSel = gNodes
    .selectAll('path')
    .data(nodes)
    .join('path')
    .attr('d', (n) =>
      symbol.type(SYMBOLS[n.item.kind] || d3.symbolCircle).size(n.r * n.r * Math.PI)(),
    )
    .attr('fill', (n) =>
      noUsageTool(n) ? AXIS_COLOR[n.cls.primary] : n.usage.count === 0 ? DEAD : AXIS_COLOR[n.cls.primary],
    )
    .attr('fill-opacity', (n) => (noUsageTool(n) ? 0.75 : n.usage.count === 0 ? 0.55 : 0.92))
    .attr('stroke', (n) => {
      if (toolList.filter((t) => t.detected).length < 2) return noUsageTool(n) ? '#a9b2c3' : SURFACE;
      const meta = toolMeta.get(n.item.tool);
      return meta !== undefined ? meta.color : SURFACE;
    })
    .attr('stroke-dasharray', (n) => (noUsageTool(n) ? '3 3' : null))
    .attr('class', (n) => (noUsageTool(n) ? 'no-usage' : null))
    .attr('stroke-width', 2)
    .style('cursor', 'pointer');

  const labeled = nodes
    .filter((n) => n.usage.count > 0)
    .sort((a, b) => b.usage.count - a.usage.count)
    .slice(0, 10);
  const labelSel = gNodes
    .selectAll('text')
    .data(labeled)
    .join('text')
    .attr('class', 'node-label')
    .text((n) => (n.item.name.length > 20 ? n.item.name.slice(0, 19) + '…' : n.item.name));

  function ticked() {
    nodeSel.attr('transform', (n) => 'translate(' + n.x + ',' + n.y + ')');
    labelSel.attr('x', (n) => n.x).attr('y', (n) => n.y - n.r - 6);
    linkSel
      .attr('x1', (n) => n.x)
      .attr('y1', (n) => n.y)
      .attr('x2', (n) => hubPos[n.cls.primary].x)
      .attr('y2', (n) => hubPos[n.cls.primary].y);
    overlapSel
      .attr('x1', (p) => p.a.x)
      .attr('y1', (p) => p.a.y)
      .attr('x2', (p) => p.b.x)
      .attr('y2', (p) => p.b.y);
  }

  const sim = d3
    .forceSimulation(nodes)
    .force('x', d3.forceX((n) => hubPos[n.cls.primary].x).strength(0.09))
    .force('y', d3.forceY((n) => hubPos[n.cls.primary].y).strength(0.09))
    .force('charge', d3.forceManyBody().strength(-28))
    .force('collide', d3.forceCollide((n) => n.r + 3.5))
    .on('tick', ticked);

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    sim.stop();
    sim.tick(300);
    ticked();
  }

  nodeSel.call(
    d3
      .drag()
      .on('start', (event, n) => {
        if (!event.active) sim.alphaTarget(0.2).restart();
        n.fx = n.x;
        n.fy = n.y;
      })
      .on('drag', (event, n) => {
        n.fx = event.x;
        n.fy = event.y;
      })
      .on('end', (event, n) => {
        if (!event.active) sim.alphaTarget(0);
        n.fx = null;
        n.fy = null;
      }),
  );

  /* ---------- tooltip ---------- */
  const tip = document.getElementById('tooltip');
  function placeTip(event) {
    tip.style.left = event.clientX + 14 + 'px';
    tip.style.top = event.clientY + 10 + 'px';
  }
  nodeSel
    .on('mouseenter', (event, n) => {
      placeTip(event);
      tip.textContent = '';
      const t1 = document.createElement('div');
      t1.textContent = n.item.name;
      const t2 = document.createElement('div');
      t2.className = 't2';
      const meta = toolMeta.get(n.item.tool);
      t2.textContent =
        n.item.kind +
        ' · ' +
        n.cls.primary +
        ' · ' +
        (noUsageTool(n)
          ? 'usage unavailable for ' + (meta !== undefined ? meta.displayName : n.item.tool)
          : n.usage.count === 0
            ? 'never fired'
            : n.usage.count + '× in ' + data.days + 'd');
      tip.append(t1, t2);
      tip.hidden = false;
    })
    .on('mousemove', placeTip)
    .on('mouseleave', () => {
      tip.hidden = true;
    });

  /* ---------- detail panel ---------- */
  const panel = document.getElementById('detail-panel');

  function statBlock(value, key) {
    const wrap = document.createElement('div');
    wrap.className = 'stat';
    const v = document.createElement('div');
    v.className = 'v';
    v.textContent = value;
    const k = document.createElement('div');
    k.className = 'k';
    k.textContent = key;
    wrap.append(v, k);
    return wrap;
  }

  function showPanel(n) {
    panel.textContent = '';
    const kind = document.createElement('div');
    kind.className = 'panel-kind';
    kind.style.color = AXIS_COLOR[n.cls.primary];
    kind.textContent = KIND_GLYPH[n.item.kind] + ' ' + n.item.kind + ' · ' + n.cls.primary;
    const name = document.createElement('h2');
    name.className = 'panel-name';
    name.textContent = n.item.name;
    panel.append(kind, name);

    if (n.item.description) {
      const desc = document.createElement('p');
      desc.className = 'panel-desc';
      desc.textContent = n.item.description;
      panel.append(desc);
    }
    const summary = document.createElement('p');
    summary.className = 'panel-summary';
    summary.textContent = n.cls.summary;
    panel.append(summary);

    const stats = document.createElement('div');
    stats.className = 'panel-stats';
    stats.append(
      statBlock(String(n.usage.count), 'fired · ' + data.days + 'd'),
      statBlock(String(n.usage.sessionsSeen), 'sessions'),
      statBlock(
        n.usage.lastUsed ? n.usage.lastUsed.slice(0, 10) : 'never',
        'last used',
      ),
      statBlock((n.item.sizeBytes / 1024).toFixed(1) + ' kB', 'size'),
    );
    panel.append(stats);

    for (const axis of AXES) {
      const share = n.cls.weights[axis] || 0;
      const row = document.createElement('div');
      row.className = 'wrow';
      const k = document.createElement('span');
      k.className = 'wk';
      k.textContent = axis;
      const track = document.createElement('div');
      track.className = 'wtrack';
      const fill = document.createElement('div');
      fill.className = 'wfill';
      fill.style.width = Math.round(share * 100) + '%';
      fill.style.background = AXIS_COLOR[axis];
      track.append(fill);
      const v = document.createElement('span');
      v.className = 'wv';
      v.textContent = Math.round(share * 100) + '%';
      row.append(k, track, v);
      panel.append(row);
    }

    const path = document.createElement('div');
    path.className = 'panel-path';
    path.textContent = n.item.sourcePath;
    panel.append(path);

    const method = document.createElement('div');
    method.className = 'panel-method';
    method.textContent =
      'classified by ' + n.cls.method + (n.cls.flags ? ' · ' + n.cls.flags.join(', ') : '');
    panel.append(method);

    panel.hidden = false;
  }

  nodeSel.on('click', (event, n) => {
    event.stopPropagation();
    tip.hidden = true;
    showPanel(n);
  });
  svg.on('click', () => {
    panel.hidden = true;
  });

  /* ---------- legend + filters ---------- */
  const legendAxes = document.getElementById('legend-axes');
  for (const axis of AXES) {
    const count = nodes.filter((n) => n.cls.primary === axis).length;
    if (count === 0) continue;
    const row = document.createElement('div');
    row.className = 'key-row';
    const dot = document.createElement('span');
    dot.className = 'key-dot';
    dot.style.background = AXIS_COLOR[axis];
    const label = document.createElement('span');
    label.textContent = axis;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = String(count);
    row.append(dot, label, n);
    legendAxes.append(row);
  }

  const kindOn = {};
  const kindFilters = document.getElementById('kind-filters');
  const kindsPresent = [...new Set(nodes.map((n) => n.item.kind))];
  for (const kind of kindsPresent) {
    kindOn[kind] = true;
    const row = document.createElement('label');
    row.className = 'filter-row';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.addEventListener('change', () => {
      kindOn[kind] = box.checked;
      applyFilters();
    });
    const glyph = document.createElement('span');
    glyph.className = 'key-glyph';
    glyph.textContent = KIND_GLYPH[kind] || '●';
    const label = document.createElement('span');
    label.textContent = kind;
    row.append(box, glyph, label);
    kindFilters.append(row);
  }

  const toolOn = {};
  const toolFilters = document.getElementById('tool-filters');
  if (toolFilters !== null) {
    const toolsPresent = [...new Set(nodes.map((n) => n.item.tool).filter(Boolean))];
    for (const tool of toolsPresent) {
      toolOn[tool] = true;
      const meta = toolMeta.get(tool);
      const row = document.createElement('label');
      row.className = 'filter-row';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = true;
      box.addEventListener('change', () => {
        toolOn[tool] = box.checked;
        applyFilters();
      });
      const dot = document.createElement('span');
      dot.className = 'key-dot';
      dot.style.background = meta !== undefined ? meta.color : '#8a93a6';
      const label = document.createElement('span');
      label.textContent = meta !== undefined ? meta.displayName : tool;
      row.append(box, dot, label);
      toolFilters.append(row);
    }
  }

  const hideUnused = document.getElementById('hide-unused');
  hideUnused.addEventListener('change', applyFilters);

  function applyFilters() {
    const visible = (n) =>
      kindOn[n.item.kind] !== false &&
      toolOn[n.item.tool] !== false &&
      (!hideUnused.checked || n.usage.count > 0 || noUsageTool(n));
    nodeSel.attr('display', (n) => (visible(n) ? null : 'none'));
    labelSel.attr('display', (n) => (visible(n) ? null : 'none'));
    linkSel.attr('display', (n) => (visible(n) ? null : 'none'));
    overlapSel.attr('display', (p) => (visible(p.a) && visible(p.b) ? null : 'none'));
    panel.hidden = true;
  }

  /* ---------- diagnostics lists (spec §5) ---------- */
  // Backtick-quoted spans in finding lines render as <code>; all via textContent.
  function lineInto(li, line) {
    const parts = line.split('`');
    parts.forEach((part, i) => {
      if (part === '') return;
      if (i % 2 === 1) {
        const code = document.createElement('code');
        code.textContent = part;
        li.append(code);
      } else {
        li.append(document.createTextNode(part));
      }
    });
  }

  function fillList(colId, findings, opts) {
    const list = document.querySelector('#' + colId + ' .diag-list');
    const max = (opts && opts.max) || findings.length;
    if (findings.length === 0) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = (opts && opts.emptyText) || 'None found.';
      list.append(li);
      return;
    }
    for (const finding of findings.slice(0, max)) {
      const li = document.createElement('li');
      lineInto(li, finding.line);
      const nodeId = finding.itemId || (finding.itemIds && finding.itemIds[0]);
      const node = nodeId ? nodeById.get(nodeId) : undefined;
      if (node) {
        li.className = 'clickable';
        li.addEventListener('click', () => {
          showPanel(node);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        });
      }
      list.append(li);
    }
    if (findings.length > max) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = '… and ' + (findings.length - max) + ' more (see --json for all).';
      list.append(li);
    }
  }

  fillList('diag-dead', data.diagnostics.deadWeight, {
    max: 12,
    emptyText: 'Nothing unused — everything installed fired in this window.',
  });
  fillList('diag-overlaps', data.diagnostics.overlaps, {
    emptyText: 'No suspected duplicates.',
  });
  fillList('diag-gaps', data.diagnostics.gaps, {
    emptyText: 'No gaps — every axis has real coverage.',
  });

  /* ---------- cross-tool diagnostics (SPEC_V2 §4.5) ---------- */
  const crossTool = data.crossTool || { duplicates: [], imbalance: [], rulesOverlaps: [] };
  const crossSection = document.getElementById('crosstool');
  const multiToolMap = [...new Set(nodes.map((n) => n.item.tool).filter(Boolean))].length > 1;
  if (crossSection !== null && multiToolMap) {
    crossSection.hidden = false;
    fillList('diag-xtool-dupes', crossTool.duplicates, {
      emptyText: 'No MCP server is installed in more than one tool.',
    });
    fillList('diag-xtool-imbalance', crossTool.imbalance, {
      emptyText: 'Capabilities are spread across your tools.',
    });
    fillList('diag-xtool-rules', crossTool.rulesOverlaps, {
      emptyText: 'No overlapping rules files across tools.',
    });
  }

  /* ---------- share card (spec §4.4 — in-page PNG export, zero deps) ---------- */
  const shareBtn = document.getElementById('share-btn');

  function mapSnapshot() {
    return new Promise((resolveSnap) => {
      const clone = svg.node().cloneNode(true);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', String(W));
      clone.setAttribute('height', String(H));
      const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
      style.textContent =
        '.hub-label{font:12px ui-monospace,Menlo,monospace;letter-spacing:.22em;text-anchor:middle}' +
        '.node-label{font:10.5px ui-monospace,Menlo,monospace;fill:#a9b2c3;text-anchor:middle}';
      clone.insertBefore(style, clone.firstChild);
      const url = URL.createObjectURL(
        new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }),
      );
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolveSnap(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolveSnap(null);
      };
      img.src = url;
    });
  }

  async function exportShareCard() {
    shareBtn.disabled = true;
    try {
      const SCALE = 2;
      const CW = 1200;
      const CH = 630;
      const canvas = document.createElement('canvas');
      canvas.width = CW * SCALE;
      canvas.height = CH * SCALE;
      const ctx = canvas.getContext('2d');
      ctx.scale(SCALE, SCALE);

      const MONO = 'ui-monospace, Menlo, monospace';
      const SERIF = '"Iowan Old Style", Palatino, Georgia, serif';

      ctx.fillStyle = '#0b0e15';
      ctx.fillRect(0, 0, CW, CH);

      // right: map snapshot on the chart surface
      const snap = await mapSnapshot();
      const mapX = 560;
      ctx.fillStyle = SURFACE;
      ctx.fillRect(mapX, 0, CW - mapX, CH);
      if (snap) {
        const scale = Math.max((CW - mapX) / W, CH / H);
        const dw = W * scale;
        const dh = H * scale;
        ctx.drawImage(snap, mapX + (CW - mapX - dw) / 2, (CH - dh) / 2, dw, dh);
      }

      // left column
      const L = 56;
      ctx.fillStyle = '#eef1f7';
      ctx.font = 'italic 46px ' + SERIF;
      ctx.fillText('Agent Atlas', L, 92);
      ctx.font = '11px ' + MONO;
      ctx.fillStyle = '#6f7a8d';
      ctx.fillText(
        (data.tool + ' · last ' + data.days + ' days').toUpperCase(),
        L,
        116,
      );

      // headline stats
      const neverUsed = data.diagnostics.deadWeight.length;
      const stats = [
        [String(nodes.length), 'capabilities'],
        [String(data.usage.totalSessions), 'sessions'],
        [String(neverUsed), 'never used'],
      ];
      stats.forEach(([value, label], i) => {
        const x = L + i * 155;
        ctx.fillStyle = '#eef1f7';
        ctx.font = '600 40px ' + MONO;
        ctx.fillText(value, x, 196);
        ctx.fillStyle = '#6f7a8d';
        ctx.font = '10px ' + MONO;
        ctx.fillText(label.toUpperCase(), x, 216);
      });

      // tuning bar
      const shares = tuningShares(tuneMode) || tuningShares('installed') || [];
      const barY = 256;
      const barW = 448;
      let x = L;
      for (const s of shares) {
        const w = Math.max(4, s.share * barW - 2);
        ctx.fillStyle = AXIS_COLOR[s.axis];
        ctx.beginPath();
        ctx.roundRect(x, barY, w, 20, 3);
        ctx.fill();
        x += w + 2;
      }
      let lx = L;
      ctx.font = '10px ' + MONO;
      for (const s of shares) {
        if (s.share < 0.04) continue;
        ctx.fillStyle = AXIS_COLOR[s.axis];
        ctx.fillText(s.axis + ' ' + Math.round(s.share * 100) + '%', lx, barY + 38);
        lx += ctx.measureText(s.axis + ' 00% ').width + 14;
      }

      // top dead-weight line, wrapped
      const topDead = data.diagnostics.deadWeight[0];
      if (topDead) {
        ctx.fillStyle = '#a9b2c3';
        ctx.font = '13px ' + MONO;
        const words = topDead.line.replace(/`/g, '').split(' ');
        let lineText = '';
        let y = barY + 84;
        for (const word of words) {
          const probe = lineText === '' ? word : lineText + ' ' + word;
          if (ctx.measureText(probe).width > 448 && lineText !== '') {
            ctx.fillText(lineText, L, y);
            y += 20;
            lineText = word;
          } else {
            lineText = probe;
          }
        }
        if (lineText !== '') ctx.fillText(lineText, L, y);
      }

      ctx.fillStyle = '#6f7a8d';
      ctx.font = '12px ' + MONO;
      ctx.fillText('npx agent-atlas', L, CH - 44);

      canvas.toBlob((blob) => {
        if (blob) {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'agent-atlas.png';
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        }
        shareBtn.disabled = false;
      }, 'image/png');
    } catch (err) {
      shareBtn.disabled = false;
    }
  }

  shareBtn.addEventListener('click', exportShareCard);
})();
