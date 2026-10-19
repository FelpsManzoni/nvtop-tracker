// Per-GPU idle bookkeeping for one server: the live idle timer (idleSince) plus recorded idle
// periods for "last idle" and the 30-day total. Pure (no I/O) -- idleStore.js persists it.
// Rules: docs/superpowers/specs/2026-10-15-gpu-idle-history-design.md
const MIN_IDLE_MS = 10 * 60_000; // raw idle stretch needed to open a period
const MIN_BUSY_MS = 10 * 60_000; // continuous activity needed to close one
const WINDOW_MS = 30 * 24 * 60 * 60_000; // rolling window for the total, and retention
const GAP_MS = 5 * 60_000; // longer without a sample = unknown, so break state

function freshGpu() {
  return { idleSince: null, busySince: null, openStart: null, lastSampleAt: null, periods: [] };
}

class IdleHistory {
  constructor(saved) {
    this.gpus = new Map();
    for (const [id, raw] of Object.entries(saved || {})) {
      // Hand-edited or damaged files: keep only finite timestamps and well-formed periods.
      const s = raw && typeof raw === 'object' ? raw : {};
      const time = (v) => (Number.isFinite(v) ? v : null);
      this.gpus.set(id, {
        idleSince: time(s.idleSince),
        busySince: time(s.busySince),
        openStart: time(s.openStart),
        lastSampleAt: time(s.lastSampleAt),
        periods: (Array.isArray(s.periods) ? s.periods : [])
          .filter((p) => p && Number.isFinite(p.start) && Number.isFinite(p.end) && p.start <= p.end)
          .map(({ start, end }) => ({ start, end })),
      });
    }
  }

  static fromJSON(saved) {
    return new IdleHistory(saved);
  }

  update(gpus, now = Date.now()) {
    for (const { key, utilization } of gpus) {
      if (!Number.isFinite(utilization)) continue; // unknown utilization: leave state untouched
      if (!this.gpus.has(key)) this.gpus.set(key, freshGpu());
      const s = this.gpus.get(key);

      // A long gap, or the clock moving backwards, means we don't know what happened in between.
      if (s.lastSampleAt !== null && (now < s.lastSampleAt || now - s.lastSampleAt > GAP_MS)) {
        if (s.openStart !== null) s.periods.push({ start: s.openStart, end: s.lastSampleAt });
        s.idleSince = s.busySince = s.openStart = null;
      }

      if (utilization < 1) {
        s.idleSince ??= now;
        s.busySince = null;
      } else {
        s.busySince ??= now;
        s.idleSince = null;
      }

      if (s.openStart === null && s.idleSince !== null && now - s.idleSince > MIN_IDLE_MS) {
        s.openStart = s.idleSince;
      }
      if (s.openStart !== null && s.busySince !== null && now - s.busySince > MIN_BUSY_MS) {
        s.periods.push({ start: s.openStart, end: s.busySince });
        s.openStart = null;
      }

      s.lastSampleAt = now;
      s.periods = s.periods.filter((p) => p.end >= now - WINDOW_MS);
    }
  }

  summary(key, now = Date.now()) {
    const s = this.gpus.get(key);
    if (!s) return { idleSince: null, lastIdleMs: null, idle30dMs: 0 };
    const from = now - WINDOW_MS;
    const overlap = (start, end) => Math.max(0, Math.min(end, now) - Math.max(start, from));
    let idle30dMs = s.periods.reduce((sum, p) => sum + overlap(p.start, p.end), 0);
    if (s.openStart !== null && s.lastSampleAt !== null) idle30dMs += overlap(s.openStart, s.lastSampleAt);
    const last = s.periods[s.periods.length - 1];
    return { idleSince: s.idleSince, lastIdleMs: last ? last.end - last.start : null, idle30dMs };
  }

  annotate(gpus, now = Date.now()) {
    return gpus.map((g) => ({ ...g, ...this.summary(g.key, now) }));
  }

  toJSON() {
    return Object.fromEntries(this.gpus);
  }
}

module.exports = { IdleHistory };
