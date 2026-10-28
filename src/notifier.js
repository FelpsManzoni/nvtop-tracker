// Pure state machine: decides which Teams cards are due. No timers, no I/O, no Date.now().
const { idleCard, downCard, recoveryCard } = require('./teams');

const IDLE_NOTIFY_STEP_MS = 12 * 3600_000;
const DOWN_NOTICE_AFTER_MS = 5 * 60_000;
const DOWN_REMINDER_MS = 3600_000;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function normalize(s) {
  s = s && typeof s === 'object' ? s : {};
  const out = {
    downSince: num(s.downSince),
    lastError: typeof s.lastError === 'string' ? s.lastError : null,
    noticeAt: num(s.noticeAt),
    recoveryPending: null,
    idle: {},
  };
  if (out.downSince === null || out.noticeAt === null) {
    out.downSince = null; out.lastError = null; out.noticeAt = null; // outage never announced
  }
  const r = s.recoveryPending;
  if (r && num(r.downSince) !== null && num(r.recoveredAt) !== null) {
    out.recoveryPending = { downSince: r.downSince, recoveredAt: r.recoveredAt };
  }
  for (const [k, v] of Object.entries(s.idle && typeof s.idle === 'object' ? s.idle : {})) {
    if (v && num(v.idleSince) !== null && num(v.milestone) !== null) {
      out.idle[k] = { idleSince: v.idleSince, milestone: v.milestone };
    }
  }
  return out;
}

class Notifier {
  constructor({ send, saved } = {}) {
    this.send = send; // public and mutable: tests may replace it
    this.state = {};
    for (const [name, s] of Object.entries(saved && typeof saved === 'object' ? saved : {})) {
      this.state[name] = normalize(s);
    }
    this.observed = new Set(); // servers with a successful observe in this process
    this.entries = {}; // latest GPU entries per server, in memory only
  }

  _s(server) {
    return (this.state[server] ||= normalize(null));
  }

  observe(server, { ok, entries, error, now }) {
    const s = this._s(server);
    if (!ok) {
      if (s.downSince === null) s.downSince = now;
      s.lastError = String(error ?? '');
      return;
    }
    if (s.downSince !== null && s.noticeAt !== null) {
      s.recoveryPending = { downSince: s.downSince, recoveredAt: now };
    }
    s.downSince = null; s.lastError = null; s.noticeAt = null;
    this.entries[server] = entries || [];
    this.observed.add(server);
  }

  // The data source failed, so nothing is known about this server right now: its GPUs leave the
  // idle evaluation (no alert from stale data) without counting as an outage, and their notified
  // milestones are kept.
  unknown(server) {
    this.entries[server] = [];
  }

  async _try(card, onSuccess) {
    try {
      await this.send(card);
    } catch (err) {
      console.warn(`notifier: send failed (${err.message})`);
      return;
    }
    onSuccess();
  }

  async tick(now) {
    for (const [server, s] of Object.entries(this.state)) {
      if (!s.recoveryPending) continue;
      const { downSince, recoveredAt } = s.recoveryPending;
      await this._try(recoveryCard({ server, downSince, recoveredAt }), () => { s.recoveryPending = null; });
    }
    for (const [server, s] of Object.entries(this.state)) {
      if (s.downSince === null || now - s.downSince < DOWN_NOTICE_AFTER_MS) continue;
      if (s.noticeAt !== null && now - s.noticeAt < DOWN_REMINDER_MS) continue;
      await this._try(
        downCard({ server, downSince: s.downSince, error: s.lastError, now }),
        () => { s.noticeAt = now; },
      );
    }
    await this._idle(now);
  }

  async _idle(now) {
    const idleNow = []; // { server, s, key, label, idleSince, milestone }
    for (const [server, s] of Object.entries(this.state)) {
      const busy = new Set(); // keys known (finite utilization) and not idle
      if (s.downSince === null) {
        for (const e of this.entries[server] || []) {
          if (!Number.isFinite(e.utilization)) continue;
          if (e.idleSince == null) { busy.add(e.key); continue; }
          idleNow.push({
            server, s, key: e.key, label: e.label, idleSince: e.idleSince,
            milestone: Math.floor((now - e.idleSince) / IDLE_NOTIFY_STEP_MS),
          });
        }
      }
      // prune only keys positively known busy; unknown/absent keys keep their record (no duplicates)
      if (s.downSince === null && this.observed.has(server)) {
        for (const k of busy) delete s.idle[k];
      }
    }
    const listed = idleNow.filter((e) => e.milestone >= 1);
    const due = listed.some((e) => {
      const r = e.s.idle[e.key];
      return !r || r.idleSince !== e.idleSince || r.milestone < e.milestone;
    });
    if (!due) return;
    const rows = listed.map((e) => ({ server: e.server, label: e.label, idleMs: now - e.idleSince }));
    await this._try(idleCard(rows), () => {
      for (const e of listed) e.s.idle[e.key] = { idleSince: e.idleSince, milestone: e.milestone };
    });
  }

  toJSON() {
    return JSON.parse(JSON.stringify(this.state));
  }
}

module.exports = { Notifier, IDLE_NOTIFY_STEP_MS, DOWN_NOTICE_AFTER_MS, DOWN_REMINDER_MS };
