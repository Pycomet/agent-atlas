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
      return {
        id: item.id,
        item,
        usage,
        cls: clsById.get(item.id),
        r: 7 + 4 * Math.log2(usage.count + 1),
      };
    });

  /* ---------- tuning bar ---------- */
  function tuningShares(mode) {
    const totals = Object.fromEntries(AXES.map((a) => [a, 0]));
    let denom = 0;
    for (const n of nodes) {
      const w = mode === 'used' ? n.usage.count : 1;
      if (w === 0) continue;
      denom += w;
      for (const a of AXES) totals[a] += (n.cls.weights[a] || 0) * w;
    }
    return denom === 0 ? null : AXES.map((a) => ({ axis: a, share: totals[a] / denom }));
  }

  function renderTuning(mode) {
    const bar = document.getElementById('tuning-bar');
    bar.textContent = '';
    const shares = tuningShares(mode) || tuningShares('installed');
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
      bar.appendChild(seg);
    }
  }

  const totalUse = nodes.reduce((s, n) => s + n.usage.count, 0);
  const btnUsed = document.getElementById('toggle-used');
  const btnInstalled = document.getElementById('toggle-installed');
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
    renderTuning(mode);
  }
  btnUsed.addEventListener('click', () => setTuneMode('used'));
  btnInstalled.addEventListener('click', () => setTuneMode('installed'));
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
    .selectAll('line')
    .data(nodes)
    .join('line')
    .attr('stroke', (n) => AXIS_COLOR[n.cls.primary])
    .attr('stroke-opacity', 0.13)
    .attr('stroke-width', 1);

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
    .attr('fill', (n) => (n.usage.count === 0 ? DEAD : AXIS_COLOR[n.cls.primary]))
    .attr('fill-opacity', (n) => (n.usage.count === 0 ? 0.55 : 0.92))
    .attr('stroke', SURFACE)
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
      t2.textContent =
        n.item.kind +
        ' · ' +
        n.cls.primary +
        ' · ' +
        (n.usage.count === 0 ? 'never fired' : n.usage.count + '× in ' + data.days + 'd');
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

  const hideUnused = document.getElementById('hide-unused');
  hideUnused.addEventListener('change', applyFilters);

  function applyFilters() {
    const visible = (n) =>
      kindOn[n.item.kind] !== false && (!hideUnused.checked || n.usage.count > 0);
    nodeSel.attr('display', (n) => (visible(n) ? null : 'none'));
    labelSel.attr('display', (n) => (visible(n) ? null : 'none'));
    linkSel.attr('display', (n) => (visible(n) ? null : 'none'));
    panel.hidden = true;
  }
})();
