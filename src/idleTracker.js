// Tracks, per GPU id, when it last went idle (< 1% utilization). Lives server-side so the
// timer survives browser reloads and outlasts the rolling history window. A failed poll
// simply doesn't call update(), leaving idleSince untouched.
// ponytail: in-memory only, a server restart resets every timer -- persist if that matters.
class IdleTracker {
  constructor() {
    this.since = new Map();
  }

  update(gpus, now = Date.now()) {
    for (const g of gpus) {
      if (g.utilization >= 1) this.since.delete(g.id);
      else if (!this.since.has(g.id)) this.since.set(g.id, now);
    }
  }

  idleSince(id) {
    return this.since.has(id) ? this.since.get(id) : null;
  }

  annotate(gpus) {
    return gpus.map((g) => ({ ...g, idleSince: this.idleSince(g.id) }));
  }
}

module.exports = { IdleTracker };
