const EventEmitter = require('events');
const { SSHManager } = require('./sshManager');
const { RollingBuffer } = require('./rollingBuffer');
const { parseGpuCsv, parseDf } = require('./parsers');

function initialState(name) {
  return {
    server: name,
    timestamp: Date.now(),
    connected: false,
    gpu: [],
    disk: [],
    trends: { gpuAvgUtilization1m: null, gpuAvgUtilization5m: null, gpuMaxUtilization5m: null },
    history: [],
    error: null,
  };
}

class Collector extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.state = new Map();
    this.buffers = new Map();
    this.ssh = new Map();
    this.timers = [];

    for (const server of config.servers) {
      this.state.set(server.name, initialState(server.name));
      this.buffers.set(server.name, new RollingBuffer({ historyMinutes: config.gpuHistoryMinutes }));
      this.ssh.set(
        server.name,
        new SSHManager(server, {
          maxAttempts: config.sshRetryMaxAttempts,
          retryDelayMs: config.sshRetryDelayMs,
        })
      );
    }
  }

  start() {
    for (const server of this.config.servers) {
      this._pollGpu(server);
      this._pollDisk(server);
      this.timers.push(setInterval(() => this._pollGpu(server), this.config.gpuPollIntervalMs));
      this.timers.push(setInterval(() => this._pollDisk(server), this.config.diskPollIntervalMs));
    }
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const ssh of this.ssh.values()) ssh.disconnect();
  }

  async _pollGpu(server) {
    const ssh = this.ssh.get(server.name);
    const state = this.state.get(server.name);
    try {
      const output = await ssh.exec(this.config.gpuQueryCommand);
      const gpus = parseGpuCsv(output);
      const buffer = this.buffers.get(server.name);
      buffer.push(gpus, Date.now());
      Object.assign(state, {
        connected: true,
        error: null,
        gpu: gpus,
        trends: buffer.getTrends(),
        history: buffer.getHistory(),
        timestamp: Date.now(),
      });
    } catch (err) {
      Object.assign(state, { connected: false, error: err.message, timestamp: Date.now() });
    }
    this.emit('update', { ...state });
  }

  async _pollDisk(server) {
    const ssh = this.ssh.get(server.name);
    const state = this.state.get(server.name);
    try {
      const output = await ssh.exec(this.config.diskQueryCommand);
      state.disk = parseDf(output, this.config.diskStorageAlertThreshold);
      state.connected = true;
      state.error = null;
    } catch (err) {
      state.connected = false;
      state.error = err.message;
    }
    state.timestamp = Date.now();
    this.emit('update', { ...state });
  }

  getSnapshot() {
    return [...this.state.values()];
  }
}

module.exports = { Collector };
