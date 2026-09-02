const servers = new Map(); // name -> latest state
const order = []; // insertion order, for stable sidebar ordering
let focused = null;

const serverListEl = document.getElementById('server-list');
const mainEl = document.getElementById('main');

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtBytes(kb) {
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
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

function renderGpuGraph(history) {
  const width = 600;
  const height = 160;
  if (!history.length) return `<svg id="gpu-graph" viewBox="0 0 ${width} ${height}"></svg>`;

  const now = history[history.length - 1].timestamp;
  const windowMs = 5 * 60 * 1000;
  const points = history.map((p) => {
    const x = width - ((now - p.timestamp) / windowMs) * width;
    const y = height - (p.avgUtilization / 100) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return `
    <svg id="gpu-graph" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <polyline points="${points.join(' ')}" fill="none" stroke="#3ecf5c" stroke-width="2" />
    </svg>`;
}

function renderMain() {
  if (!focused || !servers.has(focused)) {
    mainEl.innerHTML = '<div id="empty-state">Waiting for data&hellip;</div>';
    return;
  }
  const state = servers.get(focused);
  const lastUpdated = new Date(state.timestamp).toLocaleTimeString();
  const anyDiskAlert = state.disk.some((d) => d.alert);

  const gpuRows = state.gpu.length
    ? state.gpu
        .map(
          (g) => `
        <tr>
          <td>GPU ${g.id}</td>
          <td>${g.utilization}%</td>
          <td>${fmtBytes(g.memory.used)} / ${fmtBytes(g.memory.total)}</td>
          <td>${g.temperature}&deg;C</td>
        </tr>`
        )
        .join('')
    : '<tr><td colspan="4">No GPU data</td></tr>';

  const trends = state.trends || {};
  const fmtPct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)}%`);

  const diskRows = state.disk.length
    ? state.disk
        .map(
          (d) => `
        <div class="disk-row">
          <div class="label">
            <span>${escapeHtml(d.mountpoint)} (${escapeHtml(d.filesystem)})</span>
            <span>${fmtBytes(d.used)} / ${fmtBytes(d.total)} &middot; ${d.usagePercent}%</span>
          </div>
          <div class="bar-track"><div class="bar-fill ${d.alert ? 'alert' : ''}" style="width:${d.usagePercent}%"></div></div>
        </div>`
        )
        .join('')
    : '<div>No disk data</div>';

  mainEl.innerHTML = `
    <div class="main-header">
      <h2>${escapeHtml(state.server)}</h2>
      <span class="status">${state.connected ? 'connected' : 'unreachable'} &middot; updated ${lastUpdated}</span>
      ${anyDiskAlert ? '<span class="alert-badge">DISK ALERT</span>' : ''}
    </div>

    <section>
      <h3>GPU (avg 1m: ${fmtPct(trends.gpuAvgUtilization1m)} &middot; avg 5m: ${fmtPct(trends.gpuAvgUtilization5m)} &middot; max 5m: ${fmtPct(trends.gpuMaxUtilization5m)})</h3>
      <table>
        <thead><tr><th>GPU</th><th>Util</th><th>Memory</th><th>Temp</th></tr></thead>
        <tbody>${gpuRows}</tbody>
      </table>
      ${renderGpuGraph(state.history || [])}
    </section>

    <section>
      <h3>Disk</h3>
      ${diskRows}
    </section>
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
