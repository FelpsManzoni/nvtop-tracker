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

function renderGpuGraphCard(gpu, series) {
  const width = 280;
  const height = 90;
  const windowMs = 5 * 60 * 1000;
  const now = series.length ? series[series.length - 1].timestamp : Date.now();

  const linePoints = (key) =>
    series
      .map((p) => {
        const x = width - ((now - p.timestamp) / windowMs) * width;
        const y = height - (p[key] / 100) * height;
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
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
        <polyline class="line-util" points="${linePoints('utilization')}" />
        <polyline class="line-mem" points="${linePoints('memoryPercent')}" />
      </svg>
    </div>`;
}

function renderGpuGraphs(state) {
  if (!state.gpu.length) return '<div class="empty">No GPU data</div>';
  return state.gpu.map((g) => renderGpuGraphCard(g, (state.historyByGpu && state.historyByGpu[g.id]) || [])).join('');
}

function renderGpuListCard(state) {
  const rows = state.gpu.length
    ? state.gpu
        .map(
          (g) => `
        <div class="gpu-list-row">
          <span class="gpu-list-name">${escapeHtml(g.name || `GPU ${g.id}`)}</span>
          <span class="gpu-list-stats">${g.utilization}% &middot; ${fmtMib(g.memory.used)}/${fmtMib(g.memory.total)} &middot; ${g.temperature}&deg;C</span>
        </div>`
        )
        .join('')
    : '<div class="empty">No GPU data</div>';
  return `<div class="card"><h3>GPUs</h3>${rows}</div>`;
}

function renderDockerCard(state) {
  const docker = state.docker || { containers: [], images: [] };
  const containerRows = docker.containers.length
    ? docker.containers
        .map(
          (c) => `
        <div class="docker-row">
          <span class="badge online"></span>
          <span class="docker-name">${escapeHtml(c.name)}</span>
          <span class="docker-status">${escapeHtml(c.status)}</span>
        </div>`
        )
        .join('')
    : '<div class="empty">No running containers</div>';

  const processes = state.gpuProcesses || [];
  const processRows = processes.length
    ? processes
        .map(
          (p) => `
        <div class="process-row">
          <span class="process-gpu">GPU ${p.gpuId}</span>
          <span class="process-name" title="${escapeHtml(p.fullCommand)}">${escapeHtml(p.process)}</span>
          <span class="process-mem">${fmtMib(p.memoryUsedMb)}</span>
        </div>`
        )
        .join('')
    : '<div class="empty">No GPU processes</div>';

  return `
    <div class="card">
      <h3>Docker</h3>
      ${containerRows}
      <h3>GPU Processes</h3>
      ${processRows}
    </div>`;
}

function renderDiskCard(state) {
  const anyDiskAlert = state.disk.some((d) => d.alert);
  const diskRows = state.disk.length
    ? state.disk
        .map(
          (d) => `
        <div class="disk-row">
          <div class="label">
            <span>${escapeHtml(d.mountpoint)}</span>
            <span>${fmtBytes(d.used)} / ${fmtBytes(d.total)} &middot; ${d.usagePercent}%</span>
          </div>
          <div class="bar-track"><div class="bar-fill ${d.alert ? 'alert' : ''}" style="width:${d.usagePercent}%"></div></div>
        </div>`
        )
        .join('')
    : '<div class="empty">No disk data</div>';

  return `
    <div class="card">
      <h3>Disk ${anyDiskAlert ? '<span class="alert-badge">ALERT</span>' : ''}</h3>
      ${diskRows}
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

  mainEl.innerHTML = `
    <div class="main-header">
      <h2>${escapeHtml(state.server)}</h2>
      <span class="status">${state.connected ? 'connected' : 'unreachable'} &middot; updated ${lastUpdated}</span>
      <span class="status">avg 1m: ${fmtPct(trends.gpuAvgUtilization1m)} &middot; avg 5m: ${fmtPct(trends.gpuAvgUtilization5m)} &middot; max 5m: ${fmtPct(trends.gpuMaxUtilization5m)}</span>
    </div>
    <div id="content-grid">
      <section id="gpu-graphs">${renderGpuGraphs(state)}</section>
      <aside id="info-column">
        ${renderGpuListCard(state)}
        ${renderDockerCard(state)}
        ${renderDiskCard(state)}
      </aside>
    </div>
  `;
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
  if (state.server === focused) renderMain();
};
