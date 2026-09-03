const EventEmitter = require('events');
const { SSHManager } = require('./sshManager');
const { RollingBuffer } = require('./rollingBuffer');
const {
  parseGpuCsv,
  parseDf,
  parseDockerPs,
  parseDockerImages,
  parseGpuProcesses,
  parseDuTopFolder,
  parsePsOutput,
} = require('./parsers');

function isDataMount(mountpoint, prefixes) {
  return prefixes.some((prefix) => mountpoint === prefix || mountpoint.startsWith(`${prefix}/`));
}

function shellQuote(str) {
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

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
      this._pollStatus(server);
      this.timers.push(setInterval(() => this._pollGpu(server), this.config.gpuPollIntervalMs));
      this.timers.push(setInterval(() => this._pollDisk(server), this.config.diskPollIntervalMs));
      this.timers.push(setInterval(() => this._pollStatus(server), this.config.diskPollIntervalMs));
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
        historyByGpu: buffer.getHistoryByGpu(),
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
      const volumes = parseDf(output, this.config.diskStorageAlertThreshold);
      await Promise.all(
        volumes
          .filter((v) => isDataMount(v.mountpoint, this.config.diskTopFolderMountPrefixes))
          .map((v) => this._attachTopFolder(ssh, v))
      );
      state.disk = volumes;
      state.connected = true;
      state.error = null;
    } catch (err) {
      state.connected = false;
      state.error = err.message;
    }
    state.timestamp = Date.now();
    this.emit('update', { ...state });
  }

  // Best-effort: on a large/busy filesystem the scan can time out before finishing, in
  // which case the reported "top folder" is only the biggest among whatever got scanned,
  // not necessarily the true biggest.
  // ponytail: no caching/indexing (ncdu-style) -- add if 25s repeatedly isn't enough.
  async _attachTopFolder(ssh, volume) {
    try {
      const duCommand = `timeout ${this.config.duTimeoutSeconds} du -x -k --max-depth=1 ${shellQuote(volume.mountpoint)} ; true`;
      const output = await ssh.exec(duCommand);
      volume.topFolder = parseDuTopFolder(output, volume.mountpoint);
    } catch {
      volume.topFolder = null;
    }
  }

  // Best-effort: nvidia-smi only gives the binary path, not the args or the owning user.
  // `ps` fills those in, keyed by pid; a process that already exited between the two
  // queries just keeps nvidia-smi's bare binary path and no owner.
  async _attachProcessOwners(ssh, processes) {
    if (!processes.length) return;
    try {
      const pids = [...new Set(processes.map((p) => p.pid))];
      const psOut = await ssh.exec(`ps -o pid=,user=,args= -p ${pids.join(',')}`);
      const byPid = parsePsOutput(psOut);
      for (const p of processes) {
        const info = byPid.get(p.pid);
        if (info) {
          p.owner = info.user;
          p.fullCommand = info.args;
        }
      }
    } catch {
      // leave processes without owner/args
    }
  }

  // Docker + GPU process listings change slowly, so this rides the same interval as
  // the disk poll instead of its own timer. Each check fails independently -- a
  // missing `docker` binary shouldn't blank out the GPU process list or vice versa,
  // and neither affects the server's overall `connected` status (GPU/disk polls own that).
  async _pollStatus(server) {
    const ssh = this.ssh.get(server.name);
    const state = this.state.get(server.name);

    try {
      const [containersOut, imagesOut] = await Promise.all([
        ssh.exec(this.config.dockerQueryCommand),
        ssh.exec(this.config.dockerImagesQueryCommand),
      ]);
      state.docker = { containers: parseDockerPs(containersOut), images: parseDockerImages(imagesOut) };
    } catch (err) {
      state.docker = { containers: [], images: [], error: err.message };
    }

    try {
      const [uuidOut, procOut] = await Promise.all([
        ssh.exec(this.config.gpuUuidQueryCommand),
        ssh.exec(this.config.gpuProcessesQueryCommand),
      ]);
      const processes = parseGpuProcesses(procOut, uuidOut);
      await this._attachProcessOwners(ssh, processes);
      state.gpuProcesses = processes;
    } catch (err) {
      state.gpuProcesses = [];
    }

    state.timestamp = Date.now();
    this.emit('update', { ...state });
  }

  getSnapshot() {
    return [...this.state.values()];
  }
}

module.exports = { Collector };
