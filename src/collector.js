const EventEmitter = require('events');
const path = require('path');
const { RollingBuffer } = require('./rollingBuffer');
const { IdleHistory } = require('./idleHistory');
const idleStore = require('./idleStore');
const { Notifier } = require('./notifier');
const { postCard } = require('./teams');
const { PrometheusClient } = require('./prometheus');
const { byServer, buildServerState, historySamples } = require('./promState');

const IDLE_SAVE_INTERVAL_MS = 60_000;
const NOTIFY_INTERVAL_MS = 60_000;
// The notifier tracks the team's Prometheus like a server: its outage gets its own down card
// instead of every server being reported down.
const PROMETHEUS_NAME = 'Prometheus (nvtop)';
const SERIES_QUERY = '{__name__=~"nvtop_.+"}';
const HISTORY_QUERY = '{__name__=~"nvtop_gpu_(info|utilization_percent|memory_used_mib|memory_total_mib)"}';

function initialState(name) {
  return {
    server: name,
    timestamp: Date.now(),
    connected: false,
    gpu: [],
    disk: [],
    trends: { gpuAvgUtilization1m: null, gpuAvgUtilization5m: null, gpuMaxUtilization5m: null },
    historyByGpu: {},
    docker: { containers: [], images: [] },
    gpuProcesses: [],
    error: null,
  };
}

// Reads every server's state from the team Prometheus (filled by nvtop-exporter on each host)
// and keeps the per-server idle history, graphs and Teams notifications.
class Collector extends EventEmitter {
  constructor(config, { client } = {}) {
    super();
    this.config = config;
    this.client = client || new PrometheusClient({ url: config.prometheusUrl, ...config.prometheusAuth });
    this.state = new Map();
    this.buffers = new Map();
    this.idle = new Map();
    this.timers = [];
    this.polling = false;
    this.seeded = Promise.resolve();
    this.idleHistoryFile = path.resolve(__dirname, '..', config.idleHistoryFile);
    const savedIdle = idleStore.load(this.idleHistoryFile);
    this.notifierStateFile = path.join(path.dirname(this.idleHistoryFile), 'notifier-state.json');
    // The webhook URL is a secret: it lives only in this closure, never in state, logs or errors.
    const url = config.teamsWebhookUrl;
    this.notifier = url
      ? new Notifier({ send: (card) => postCard(url, card), saved: idleStore.load(this.notifierStateFile) })
      : null;

    for (const server of config.servers) {
      this.state.set(server.name, initialState(server.name));
      this.buffers.set(server.name, new RollingBuffer({ historyMinutes: config.gpuHistoryMinutes }));
      this.idle.set(server.name, IdleHistory.fromJSON(savedIdle[server.name]));
    }
  }

  start() {
    this.seeded = this.seedHistory();
    this.poll();
    this.timers.push(setInterval(() => this.poll(), this.config.gpuPollIntervalMs));
    this.timers.push(setInterval(() => this.saveIdleHistory(), IDLE_SAVE_INTERVAL_MS));
    if (this.notifier) this.timers.push(setInterval(() => this.tickNotifier(), NOTIFY_INTERVAL_MS));
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.saveIdleHistory();
  }

  // Never throws: a failed save is logged and retried on the next interval. Servers no longer
  // in config are dropped from the file (history is keyed by server name).
  saveIdleHistory() {
    const servers = {};
    for (const [name, history] of this.idle) servers[name] = history.toJSON();
    try {
      idleStore.save(this.idleHistoryFile, servers);
    } catch (err) {
      console.warn(`idle history: saving ${this.idleHistoryFile} failed (${err.message}); will retry`);
    }
    if (!this.notifier) return;
    try {
      idleStore.save(this.notifierStateFile, this.notifier.toJSON());
    } catch (err) {
      console.warn(`notifier state: saving ${this.notifierStateFile} failed (${err.message}); will retry`);
    }
  }

  // Never throws (Notifier.tick handles send failures); no-op without a webhook.
  async tickNotifier(now = Date.now()) {
    if (!this.notifier || this.notifierTicking) return; // a slow POST must not let a second tick resend
    this.notifierTicking = true;
    try {
      await this.notifier.tick(now);
    } catch (err) {
      console.warn(`notifier: tick failed (${err.message})`);
    } finally {
      this.notifierTicking = false;
    }
  }

  // Fills the graphs with the last gpuHistoryMinutes from Prometheus, so a restart doesn't start
  // them empty. Never throws: without it the graphs just fill up live.
  async seedHistory(now = Date.now()) {
    const minutes = this.config.gpuHistoryMinutes;
    try {
      const series = await this.client.queryRange(HISTORY_QUERY, now - minutes * 60_000, now, this.config.gpuPollIntervalMs);
      for (const [name, samples] of historySamples(series)) {
        const buffer = this.buffers.get(name);
        if (buffer) for (const { timestamp, gpus } of samples) buffer.push(gpus, timestamp);
      }
    } catch (err) {
      console.warn(`history: could not load the last ${minutes} min from Prometheus (${err.message})`);
    }
  }

  // One query for every server per interval, at most one in flight.
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.seeded;
      let result;
      try {
        result = await this.client.query(SERIES_QUERY);
      } catch (err) {
        this._prometheusFailed(err);
        return;
      }
      this.notifier?.observe(PROMETHEUS_NAME, { ok: true, entries: [], now: Date.now() });
      const grouped = byServer(result.series);
      for (const server of this.config.servers) this._apply(server.name, grouped.get(server.name) || [], result.time);
    } finally {
      this.polling = false;
    }
  }

  // Freshness compares the exporter's own timestamp with Prometheus' evaluation time; everything
  // the dashboard records (graphs, idle history, notifier) uses this host's clock, as before.
  _apply(name, series, evaluatedAt) {
    const state = this.state.get(name);
    const now = Date.now();
    const s = buildServerState(series, {
      now: evaluatedAt,
      staleAfterMs: this.config.staleAfterMs,
      diskAlertThreshold: this.config.diskStorageAlertThreshold,
      userAvatars: this.config.userAvatars,
    });
    if (s.fresh) {
      const buffer = this.buffers.get(name);
      buffer.push(s.gpu, now);
      const idle = this.idle.get(name);
      idle.update(s.gpu, now);
      Object.assign(state, {
        connected: true,
        error: null,
        gpu: idle.annotate(s.gpu, now),
        trends: buffer.getTrends(now),
        historyByGpu: buffer.getHistoryByGpu(),
        gpuProcesses: s.gpuProcesses,
        docker: s.docker,
        disk: s.disk,
        timestamp: now,
      });
      this.notifier?.observe(name, { ok: true, entries: state.gpu, now });
    } else {
      // The last GPU entries stay (the browser shows them offline); stale data never reaches idle tracking.
      Object.assign(state, { connected: false, error: s.error, timestamp: now });
      this.notifier?.observe(name, { ok: false, error: s.error, now });
    }
    this.emit('update', { ...state });
  }

  // Nothing is known about any server: show it, but don't report them down or evaluate idle time.
  _prometheusFailed(err) {
    const now = Date.now();
    for (const server of this.config.servers) {
      const state = this.state.get(server.name);
      Object.assign(state, { connected: false, error: `Prometheus inacessível: ${err.message}`, timestamp: now });
      this.notifier?.unknown(server.name);
      this.emit('update', { ...state });
    }
    this.notifier?.observe(PROMETHEUS_NAME, { ok: false, error: err.message, now });
  }

  getSnapshot() {
    return [...this.state.values()];
  }
}

module.exports = { Collector, PROMETHEUS_NAME };
