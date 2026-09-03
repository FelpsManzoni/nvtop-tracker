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

// Dashboard blocks: user can drag (by the header handle) to reorder and resize (native
// corner drag handle) each one. Order + sizes persist per-browser in localStorage.
const DEFAULT_BLOCK_ORDER = ['gpu-graphs', 'gpu-list', 'docker', 'gpu-processes', 'disk'];

function loadBlockOrder() {
  const saved = JSON.parse(localStorage.getItem('blockOrder'));
  if (!Array.isArray(saved)) return [...DEFAULT_BLOCK_ORDER];
  const known = saved.filter((id) => DEFAULT_BLOCK_ORDER.includes(id));
  const missing = DEFAULT_BLOCK_ORDER.filter((id) => !known.includes(id));
  return [...known, ...missing];
}

let blockOrder = loadBlockOrder();
let blockSizes = JSON.parse(localStorage.getItem('blockSizes')) || {};

function saveBlockOrder() {
  localStorage.setItem('blockOrder', JSON.stringify(blockOrder));
}

function saveBlockSizes() {
  localStorage.setItem('blockSizes', JSON.stringify(blockSizes));
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
    blockSizes[entry.target.dataset.blockId] = { width: Math.round(width), height: Math.round(height) };
  }
  saveBlockSizes();
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

    block.addEventListener('dragover', (e) => {
      if (!draggedBlockId) return;
      e.preventDefault();
      markInteracting();
    });

    block.addEventListener('drop', (e) => {
      e.preventDefault();
      const targetId = block.dataset.blockId;
      if (draggedBlockId && draggedBlockId !== targetId) {
        blockOrder.splice(blockOrder.indexOf(draggedBlockId), 1);
        blockOrder.splice(blockOrder.indexOf(targetId), 0, draggedBlockId);
        saveBlockOrder();
      }
      draggedBlockId = null;
      renderMain();
    });
  }
}

function renderBlock(id, title, bodyHtml) {
  const size = blockSizes[id];
  const style = size ? ` style="width:${size.width}px;height:${size.height}px"` : '';
  return `
    <div class="block" data-block-id="${id}"${style}>
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

  const blocksHtml = blockOrder.map((id) => renderBlock(id, blockContent[id].title, blockContent[id].body)).join('');

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
