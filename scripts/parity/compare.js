// Compares what the current (SSH) dashboard and the new (Prometheus) one received and rendered
// for one server at nearly the same moment. The rules are the parity check's in
// docs/superpowers/specs/2026-10-28-prometheus-source-design.md. `expected: true` marks a
// by-design difference: reported, never failing the run.

const TOLERANCE = {
  utilizationPoints: 10,
  memoryPercentOfTotal: 2,
  temperatureC: 3,
  idleTimeMs: 10_000,
  idleHistoryMs: 60_000,
  diskPoints: 1,
};
const COMMAND_MAX = 500; // the new board's exporter truncates command lines

const isNum = Number.isFinite;
const hms = (text) => {
  const m = /(\d+):(\d\d):(\d\d)/.exec(text || '');
  return m ? ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 : null;
};

// A board's mean utilization of a GPU entry over the last minute (its latest reading without history).
const minuteMean = (side, gpu) => {
  const m = side.state.util1m && side.state.util1m[gpu.key];
  return isNum(m) ? m : gpu.utilization;
};

function compareServer(server, old, neu, { skipIdleTime = false } = {}) {
  const out = [];
  const add = (item, key, a, b, rule, expected = false) => out.push({ server, item, key, old: a, new: b, rule, expected });

  if (old.state.connected !== neu.state.connected) {
    add('online', '', old.state.connected, neu.state.connected, 'equal');
    return out; // nothing else is comparable while one side shows the server offline
  }
  if (!old.state.connected) return out;

  // GPU entries
  const oldKeys = old.state.gpu.map((g) => g.key);
  const newKeys = neu.state.gpu.map((g) => g.key);
  if (oldKeys.join() !== newKeys.join()) {
    // The old board drops GPUs whose memory reads [N/A] (e.g. Jetson); the new one shows them.
    const unifiedFix = !oldKeys.length && neu.state.gpu.every((g) => g.unifiedMemory);
    add('GPU entries', '', oldKeys, newKeys, 'same labels and order', unifiedFix);
  }
  const newByKey = new Map(neu.state.gpu.map((g) => [g.key, g]));
  const oldCard = new Map(old.dom.cards.map((c) => [c.label, c]));
  const newCard = new Map(neu.dom.cards.map((c) => [c.label, c]));
  for (const a of old.state.gpu) {
    const b = newByKey.get(a.key);
    if (!b) continue;
    const key = a.label;
    if (a.mig !== b.mig) add('MIG', key, a.mig, b.mig, 'equal');

    // Training loads swing between 0 and 100 % within seconds and the boards sample at different
    // instants, so the 1-minute mean of each board's own history is compared, not the latest
    // reading (the idle/busy state is compared through the status pill).
    if (isNum(a.utilization) !== isNum(b.utilization)) add('utilization', key, a.utilization, b.utilization, 'both known or both n/a');
    else if (isNum(a.utilization)) {
      const ma = minuteMean(old, a);
      const mb = minuteMean(neu, b);
      if (Math.abs(ma - mb) > TOLERANCE.utilizationPoints) {
        add('utilization', key, Math.round(ma), Math.round(mb), `1-minute mean within ±${TOLERANCE.utilizationPoints} points`);
      }
    }

    const total = Math.max(a.memory.total || 0, b.memory.total || 0);
    if (isNum(a.memory.used) !== isNum(b.memory.used)) add('memory', key, a.memory, b.memory, 'both known or both n/a');
    else if (isNum(a.memory.used) && Math.abs(a.memory.used - b.memory.used) > (total * TOLERANCE.memoryPercentOfTotal) / 100) {
      add('memory', key, a.memory, b.memory, `within ±${TOLERANCE.memoryPercentOfTotal}% of total`);
    }

    if (isNum(a.temperature) !== isNum(b.temperature)) add('temperature', key, a.temperature, b.temperature, 'both known or both n/a');
    else if (isNum(a.temperature) && Math.abs(a.temperature - b.temperature) > TOLERANCE.temperatureC) {
      add('temperature', key, a.temperature, b.temperature, `within ±${TOLERANCE.temperatureC} °C`);
    }

    const ca = oldCard.get(key);
    const cb = newCard.get(key);
    if (!ca || !cb) add('GPU card', key, !!ca, !!cb, 'rendered on both');
    else if (ca.pill !== cb.pill) add('status pill', key, ca.pill, cb.pill, 'same state');
    else if (ca.pill === 'idle' && !skipIdleTime && Math.abs(hms(ca.idleText) - hms(cb.idleText)) > TOLERANCE.idleTimeMs) {
      add('idle time', key, ca.idleText, cb.idleText, `within ±${TOLERANCE.idleTimeMs / 1000} s`);
    }

    if (!skipIdleTime) {
      for (const field of ['lastIdleMs', 'idle30dMs']) {
        const fa = a[field];
        const fb = b[field];
        if (fa === fb) continue;
        if (!isNum(fa) || !isNum(fb) || Math.abs(fa - fb) > TOLERANCE.idleHistoryMs) {
          add(`idle history (${field})`, key, fa, fb, `within ±${TOLERANCE.idleHistoryMs / 60_000} min`);
        }
      }
    }
  }

  // Owners per GPU entry, and the processes themselves
  const owners = (procs) => {
    const m = new Map();
    for (const p of procs) if (p.owner) m.set(p.gpuKey, [...new Set([...(m.get(p.gpuKey) || []), p.owner])].sort());
    return m;
  };
  const oa = owners(old.state.gpuProcesses);
  const ob = owners(neu.state.gpuProcesses);
  for (const k of new Set([...oa.keys(), ...ob.keys()])) {
    const a = (oa.get(k) || []).join(',');
    const b = (ob.get(k) || []).join(',');
    if (a !== b) add('owners', k, a, b, 'same set');
  }
  const procId = (p) => `${p.gpuKey}/${p.pid}/${p.owner || ''}`;
  const pa = new Map(old.state.gpuProcesses.map((p) => [procId(p), p]));
  const pb = new Map(neu.state.gpuProcesses.map((p) => [procId(p), p]));
  for (const [id, p] of pa) {
    if (!pb.has(id)) add('GPU process', id, 'present', 'missing', 'same (GPU, pid, owner) set');
    else if (String(p.fullCommand || '').slice(0, COMMAND_MAX) !== String(pb.get(id).fullCommand || '').slice(0, COMMAND_MAX)) {
      add('process command', id, p.fullCommand, pb.get(id).fullCommand, `equal up to ${COMMAND_MAX} chars`);
    }
  }
  for (const id of pb.keys()) if (!pa.has(id)) add('GPU process', id, 'missing', 'present', 'same (GPU, pid, owner) set');

  // Containers
  const na = new Set(old.state.docker.containers.map((c) => c.name));
  const nb = new Set(neu.state.docker.containers.map((c) => c.name));
  for (const n of na) if (!nb.has(n)) add('container', n, 'present', 'missing', 'same names');
  for (const n of nb) if (!na.has(n)) add('container', n, 'missing', 'present', 'same names');

  // Disks
  const da = new Map(old.state.disk.map((d) => [d.mountpoint, d]));
  const db = new Map(neu.state.disk.map((d) => [d.mountpoint, d]));
  for (const m of new Set([...da.keys(), ...db.keys()])) {
    const a = da.get(m);
    const b = db.get(m);
    if (!a || !b) {
      add('disk', m, a ? 'present' : 'missing', b ? 'present' : 'missing', 'same mountpoints');
      continue;
    }
    if (Math.abs(a.usagePercent - b.usagePercent) > TOLERANCE.diskPoints) {
      add('disk usage', m, a.usagePercent, b.usagePercent, `within ±${TOLERANCE.diskPoints} point`);
    }
    const ta = a.topFolder && a.topFolder.path;
    const tb = b.topFolder && b.topFolder.path;
    // The new exporter can read every directory; the old scan only what its SSH user could.
    if (ta !== tb) add('biggest folder', m, ta || null, tb || null, 'informational', true);
  }

  // Rendered rows
  for (const block of ['processRows', 'dockerRows', 'diskRows']) {
    if (old.dom[block] !== neu.dom[block]) add('rendered rows', block, old.dom[block], neu.dom[block], 'same count');
  }
  return out;
}

const mismatchId = (m) => `${m.server}|${m.item}|${m.key}`;

// Containers and disks are polled every 5 minutes by both boards, out of phase: after a change,
// one board can lag the other by up to a whole poll. Temperatures follow load swings within
// seconds, so a gap between two instants is only real once it lasts minutes.
const SLOW_POLL_MS = 5 * 60_000;
const TEMPERATURE_PERSIST_MS = 2 * 60_000;
const isSlow = (m) => ['container', 'disk', 'disk usage'].includes(m.item) || (m.item === 'rendered rows' && m.key !== 'processRows');

// A mismatch counts only when it shows in consecutive rounds: two for live readings (the boards
// sample at different instants, and processes come and go), two minutes for temperatures, and
// longer than a slow poll (plus a minute) for containers and disks. Returns the unexpected ones
// that persisted.
function persistent(rounds, { intervalMs = 30_000 } = {}) {
  const needed = (m) => {
    if (isSlow(m)) return Math.ceil((SLOW_POLL_MS + 60_000) / intervalMs) + 1;
    if (m.item === 'temperature') return Math.ceil(TEMPERATURE_PERSIST_MS / intervalMs) + 1;
    return 2;
  };
  const streak = new Map();
  const found = new Map();
  for (const round of rounds) {
    const now = new Map(round.filter((m) => !m.expected).map((m) => [mismatchId(m), m]));
    for (const id of [...streak.keys()]) if (!now.has(id)) streak.delete(id);
    for (const [id, m] of now) {
      streak.set(id, (streak.get(id) || 0) + 1);
      if (streak.get(id) >= needed(m) && !found.has(id)) found.set(id, m);
    }
  }
  return [...found.values()];
}

module.exports = { compareServer, persistent, mismatchId, TOLERANCE };
