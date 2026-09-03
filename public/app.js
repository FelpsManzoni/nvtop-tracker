const servers = new Map(); // name -> latest state
const order = []; // insertion order, for stable sidebar ordering
let focused = null;

const serverListEl = document.getElementById('server-list');
const mainEl = document.getElementById('main');

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Disk sizes come from `df -kPT` in 1024-byte blocks (KB).
function fmtBytes(kb) {
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

// GPU memory comes from nvidia-smi already in MiB -- do not run through fmtBytes (KB-based).
function fmtMib(mib) {
  if (mib < 1024) return `${mib} MB`;
  return `${(mib / 1024).toFixed(1)} GB`;
}

function avgGpuUtilization(state) {
  if (!state.gpu.length) return null;
  return Math.round(state.gpu.reduce((s, g) => s + g.utilization, 0) / state.gpu.length);
}

function maxDiskUsage(state) {
  if (!state.disk.length) return null;
  return Math.max(...state.disk.map((d) => d.usagePercent));
}

function renderSidebar() {
  serverListEl.innerHTML = order
    .map((name) => {
      const state = servers.get(name);
      const avgUtil = avgGpuUtilization(state);
      const diskMax = maxDiskUsage(state);
      const gpuText = avgUtil === null ? '—' : `avg ${avgUtil}%`;
      const diskText = diskMax === null ? '—' : `disk ${diskMax}%`;
      return `
        <div class="server-card ${name === focused ? 'focused' : ''}" data-name="${escapeHtml(name)}">
          <div class="name">
            <span class="badge ${state.connected ? 'online' : 'offline'}"></span>
            ${escapeHtml(name)}
          </div>
          <div class="meta">${gpuText} &middot; ${diskText}</div>
        </div>`;
    })
    .join('');

  for (const card of serverListEl.querySelectorAll('.server-card')) {
    card.addEventListener('click', () => {
      focused = card.dataset.name;
      renderSidebar();
      renderMain();
    });
  }
}

const GRAPH_WIDTH = 280;
const GRAPH_HEIGHT = 140;
const GRAPH_AXIS_TICKS = [100, 75, 50, 25, 0];

function renderGpuGraphCard(gpu, series) {
  const windowMs = 5 * 60 * 1000;
  const now = series.length ? series[series.length - 1].timestamp : Date.now();

  const linePoints = (key) =>
    series
      .map((p) => {
        const x = GRAPH_WIDTH - ((now - p.timestamp) / windowMs) * GRAPH_WIDTH;
        const y = GRAPH_HEIGHT - (p[key] / 100) * GRAPH_HEIGHT;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

  return `
    <div class="gpu-graph-card">
      <div class="gpu-graph-title">
        GPU ${gpu.id}
        <span class="legend util">util %</span>
        <span class="legend mem">mem %</span>
      </div>
      <div class="graph-body">
        <div class="axis-labels">${GRAPH_AXIS_TICKS.map((t) => `<span>${t}</span>`).join('')}</div>
        <svg viewBox="0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}" preserveAspectRatio="none">
          <polyline class="line-util" points="${linePoints('utilization')}" />
          <polyline class="line-mem" points="${linePoints('memoryPercent')}" />
        </svg>
      </div>
    </div>`;
}

function renderGpuGraphsBody(state) {
  if (!state.gpu.length) return '<div class="empty">No GPU data</div>';
  return `<div class="gpu-graphs-grid">${state.gpu
    .map((g) => renderGpuGraphCard(g, (state.historyByGpu && state.historyByGpu[g.id]) || []))
    .join('')}</div>`;
}

function renderGpuListBody(state) {
  if (!state.gpu.length) return '<div class="empty">No GPU data</div>';
  return state.gpu
    .map(
      (g) => `
        <div class="gpu-list-row">
          <span class="gpu-list-name">GPU ${g.id}</span>
          <span class="gpu-list-stats">${g.utilization}% &middot; ${fmtMib(g.memory.used)}/${fmtMib(g.memory.total)} &middot; ${g.temperature}&deg;C</span>
        </div>`
    )
    .join('');
}

function renderDockerBody(state) {
  const docker = state.docker || { containers: [], images: [] };
  if (!docker.containers.length) return '<div class="empty">No running containers</div>';
  return docker.containers
    .map(
      (c) => `
        <div class="docker-row">
          <span class="badge online"></span>
          <span class="docker-name">${escapeHtml(c.name)}</span>
          <span class="docker-status">${escapeHtml(c.status)}</span>
        </div>`
    )
    .join('');
}

function renderGpuProcessesBody(state) {
  const processes = state.gpuProcesses || [];
  if (!processes.length) return '<div class="empty">No GPU processes</div>';
  return processes
    .map(
      (p) => `
        <div class="process-row">
          <span class="process-gpu">GPU ${p.gpuId}</span>
          <span class="process-owner">${escapeHtml(p.owner || '—')}</span>
          <span class="process-cmd" title="${escapeHtml(p.fullCommand)}">${escapeHtml(p.fullCommand)}</span>
          <span class="process-mem">${fmtMib(p.memoryUsedMb)}</span>
        </div>`
    )
    .join('');
}

function renderDiskBody(state) {
  if (!state.disk.length) return '<div class="empty">No disk data</div>';
  return state.disk
    .map(
      (d) => `
        <div class="disk-row">
          <div class="label">
            <span>${escapeHtml(d.mountpoint)}</span>
            <span>${fmtBytes(d.used)} / ${fmtBytes(d.total)} &middot; ${d.usagePercent}%</span>
          </div>
          <div class="bar-track"><div class="bar-fill ${d.alert ? 'alert' : ''}" style="width:${d.usagePercent}%"></div></div>
          ${d.topFolder ? `<div class="top-folder">Biggest: ${escapeHtml(d.topFolder.path)} (${fmtBytes(d.topFolder.sizeKb)})</div>` : ''}
        </div>`
    )
    .join('');
}

// Dashboard blocks live on a snap-to-grid: each has a {col, row, colSpan, rowSpan} in grid
// cell units (see CELL/GAP below). Dragging a block by its header moves it to the cell under
// the cursor; resizing (native corner drag handle) rounds to the nearest whole span. Either
// action can make it overlap a neighbor, so every change runs through resolveLayout(), which
// pushes overlapping blocks down and then compacts everything back upward to close gaps --
// the same drop-resolve-compact approach tools like react-grid-layout use, written directly
// since there are only 5 blocks and it's not worth a dependency. Layout persists per-browser
// in localStorage.
const CELL = 40; // px per grid unit, both axes
const GAP = 16; // px between cells, must match #dashboard's CSS `gap`

const DEFAULT_BLOCK_LAYOUT = {
  'gpu-graphs': { col: 0, row: 0, colSpan: 11, rowSpan: 6 },
  'gpu-list': { col: 11, row: 0, colSpan: 7, rowSpan: 6 },
  docker: { col: 0, row: 6, colSpan: 7, rowSpan: 5 },
  'gpu-processes': { col: 7, row: 6, colSpan: 11, rowSpan: 5 },
  disk: { col: 0, row: 11, colSpan: 7, rowSpan: 5 },
};
const BLOCK_IDS = Object.keys(DEFAULT_BLOCK_LAYOUT);

// Inverse of span-in-px = n*CELL + (n-1)*GAP.
function pxToSpan(px) {
  return Math.max(1, Math.round((px + GAP) / (CELL + GAP)));
}

// Inverse of cell-start-in-px = n*(CELL+GAP).
function pxToCell(px) {
  return Math.max(0, Math.round(px / (CELL + GAP)));
}

function overlapsX(a, b) {
  return a.col < b.col + b.colSpan && a.col + a.colSpan > b.col;
}

function overlapsY(a, b, row) {
  return row < b.row + b.rowSpan && row + a.rowSpan > b.row;
}

// Pushes any block that overlaps an earlier (by row, then col) block straight down, then
// compacts every block back up as far as it can go without overlapping. Mutates `layout`.
function resolveLayout(layout) {
  const items = Object.values(layout);
  items.sort((a, b) => a.row - b.row || a.col - b.col);

  const placed = [];
  for (const item of items) {
    let row = item.row;
    let moved = true;
    while (moved) {
      moved = false;
      for (const p of placed) {
        if (overlapsX(item, p) && overlapsY(item, p, row)) {
          row = p.row + p.rowSpan;
          moved = true;
        }
      }
    }
    item.row = row;
    placed.push(item);
  }

  for (const item of placed) {
    while (item.row > 0 && !placed.some((p) => p !== item && overlapsX(item, p) && overlapsY(item, p, item.row - 1))) {
      item.row -= 1;
    }
  }
}

function loadBlockLayout() {
  const saved = JSON.parse(localStorage.getItem('blockLayout'));
  const layout = {};
  for (const id of BLOCK_IDS) {
    const entry = saved && saved[id];
    layout[id] = entry ? { ...entry } : { ...DEFAULT_BLOCK_LAYOUT[id] };
  }
  return layout;
}

let blockLayout = loadBlockLayout();

function saveBlockLayout() {
  localStorage.setItem('blockLayout', JSON.stringify(blockLayout));
}

// Full-page re-renders arrive every ~2s from the GPU poll (see source.onmessage below).
// Rebuilding #main mid-drag or mid-resize would yank the block out from under the
// gesture, so renders are skipped while `interacting` is true. It clears itself shortly
// after the last drag/resize event, and the next SSE tick picks the render back up.
let interacting = false;
let interactingTimer = null;
function markInteracting() {
  interacting = true;
  clearTimeout(interactingTimer);
  interactingTimer = setTimeout(() => {
    interacting = false;
  }, 400);
}

let draggedBlockId = null;

const blockResizeObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const { width, height } = entry.contentRect;
    const item = blockLayout[entry.target.dataset.blockId];
    item.colSpan = pxToSpan(width);
    item.rowSpan = pxToSpan(height);
  }
  resolveLayout(blockLayout);
  saveBlockLayout();
  markInteracting();
});

function attachBlockHandlers() {
  blockResizeObserver.disconnect();
  for (const block of mainEl.querySelectorAll('.block')) {
    blockResizeObserver.observe(block);

    block.querySelector('.block-handle').addEventListener('dragstart', (e) => {
      draggedBlockId = block.dataset.blockId;
      e.dataTransfer.effectAllowed = 'move';
      markInteracting();
    });
  }

  const dashboardEl = mainEl.querySelector('#dashboard');
  if (!dashboardEl) return;

  dashboardEl.addEventListener('dragover', (e) => {
    if (!draggedBlockId) return;
    e.preventDefault();
    markInteracting();
  });

  dashboardEl.addEventListener('drop', (e) => {
    e.preventDefault();
    if (draggedBlockId) {
      const rect = dashboardEl.getBoundingClientRect();
      const item = blockLayout[draggedBlockId];
      item.col = pxToCell(e.clientX - rect.left);
      item.row = pxToCell(e.clientY - rect.top);
      resolveLayout(blockLayout);
      saveBlockLayout();
    }
    draggedBlockId = null;
    renderMain();
  });
}

function renderBlock(id, title, bodyHtml) {
  const { col, row, colSpan, rowSpan } = blockLayout[id];
  const style = `grid-column:${col + 1}/span ${colSpan};grid-row:${row + 1}/span ${rowSpan}`;
  return `
    <div class="block" data-block-id="${id}" style="${style}">
      <div class="block-handle" draggable="true">${title}</div>
      <div class="block-body">${bodyHtml}</div>
    </div>`;
}

function renderMain() {
  if (!focused || !servers.has(focused)) {
    mainEl.innerHTML = '<div id="empty-state">Waiting for data&hellip;</div>';
    return;
  }
  const state = servers.get(focused);
  const lastUpdated = new Date(state.timestamp).toLocaleTimeString();
  const trends = state.trends || {};
  const fmtPct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)}%`);
  const diskAlert = state.disk.some((d) => d.alert) ? ' <span class="alert-badge">ALERT</span>' : '';

  const blockContent = {
    'gpu-graphs': { title: 'GPU Graphs', body: renderGpuGraphsBody(state) },
    'gpu-list': { title: 'GPUs', body: renderGpuListBody(state) },
    docker: { title: 'Docker', body: renderDockerBody(state) },
    'gpu-processes': { title: 'GPU Processes', body: renderGpuProcessesBody(state) },
    disk: { title: `Disk${diskAlert}`, body: renderDiskBody(state) },
  };

  const blocksHtml = BLOCK_IDS.map((id) => renderBlock(id, blockContent[id].title, blockContent[id].body)).join('');

  mainEl.innerHTML = `
    <div class="main-header">
      <h2>${escapeHtml(state.server)}</h2>
      <span class="status">${state.connected ? 'connected' : 'unreachable'} &middot; updated ${lastUpdated}</span>
      <span class="status">avg 1m: ${fmtPct(trends.gpuAvgUtilization1m)} &middot; avg 5m: ${fmtPct(trends.gpuAvgUtilization5m)} &middot; max 5m: ${fmtPct(trends.gpuMaxUtilization5m)}</span>
    </div>
    <div id="dashboard">${blocksHtml}</div>
  `;
  attachBlockHandlers();
}

const source = new EventSource('/stream');
source.onmessage = (event) => {
  const state = JSON.parse(event.data);
  if (!servers.has(state.server)) {
    order.push(state.server);
    if (!focused) focused = state.server;
  }
  servers.set(state.server, state);
  renderSidebar();
  if (state.server === focused && !interacting) renderMain();
};
