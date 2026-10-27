const EventEmitter = require('events');
const path = require('path');
const { SSHManager } = require('./sshManager');
const { RollingBuffer } = require('./rollingBuffer');
const { IdleHistory } = require('./idleHistory');
const idleStore = require('./idleStore');
const { Notifier } = require('./notifier');
const { postCard } = require('./teams');
const {
  parseGpuCsv,
  parseDf,
  parseDockerPs,
  parseDockerImages,
  parseGpuProcesses,
  parseDuTopFolder,
  parsePsOutput,
  parseMigXml,
  parseDcgmDiscovery,
  parseDcgmDmon,
} = require('./parsers');
const { buildGpuEntries, buildGpuProcesses } = require('./mig');

function isDataMount(mountpoint, prefixes) {
  return prefixes.some((prefix) => mountpoint === prefix || mountpoint.startsWith(`${prefix}/`));
}

function shellQuote(str) {
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

const IDLE_SAVE_INTERVAL_MS = 60_000;
const NOTIFY_INTERVAL_MS = 60_000;

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
    this.idle = new Map();
    this.processPollsInFlight = new Set();
    this.migPollsInFlight = new Set();
    this.mig = new Map(); // server -> { byGpu: Map<gpuId, parseMigXml result>, util: Map<"gpu/gi", {value, at}>, gen: Map<gpuId, number> } (gen fences off stale polls)
    this.baseProcesses = new Map();
    this.ssh = new Map();
    this.timers = [];
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
    this.timers.push(setInterval(() => this.saveIdleHistory(), IDLE_SAVE_INTERVAL_MS));
    if (this.notifier) this.timers.push(setInterval(() => this.tickNotifier(), NOTIFY_INTERVAL_MS));
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.saveIdleHistory();
    for (const ssh of this.ssh.values()) ssh.disconnect();
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

  async _pollGpu(server) {
    const ssh = this.ssh.get(server.name);
    const state = this.state.get(server.name);
    // GPU processes ride the GPU poll so owner avatars stay as fresh as the utilization
    // numbers. Their result is stored whenever it lands and goes out with the next GPU
    // update (no extra SSE re-render), so a slow/hung process query never delays GPU
    // telemetry; at most one process query per server is in flight at a time.
    if (!this.processPollsInFlight.has(server.name)) {
      this.processPollsInFlight.add(server.name);
      this._pollGpuProcesses(ssh)
        .then((processes) => {
          this.baseProcesses.set(server.name, processes);
        })
        .finally(() => this.processPollsInFlight.delete(server.name));
    }
    try {
      const output = await ssh.exec(this.config.gpuQueryCommand);
      const gpus = parseGpuCsv(output);
      const now = Date.now();
      const naGpus = gpus.filter((g) => g.utilization === null).map((g) => g.id);
      if (naGpus.length && !this.migPollsInFlight.has(server.name)) {
        this.migPollsInFlight.add(server.name);
        this._pollMig(ssh, server.name, naGpus).finally(() => this.migPollsInFlight.delete(server.name));
      }
      const mig = this.mig.get(server.name) || { byGpu: new Map(), util: new Map(), gen: new Map() };
      // Forget MIG state for GPUs that are numeric again or no longer listed.
      const stillNa = new Set(naGpus);
      for (const id of new Set([...mig.byGpu.keys(), ...mig.gen.keys()])) {
        if (stillNa.has(id)) continue;
        mig.gen.set(id, (mig.gen.get(id) || 0) + 1); // in-flight MIG polls for this GPU are now stale
        mig.byGpu.delete(id);
        for (const k of [...mig.util.keys()]) if (k.startsWith(`${id}/`)) mig.util.delete(k);
      }
      const entries = buildGpuEntries(gpus, mig.byGpu, mig.util, now, 3 * this.config.gpuPollIntervalMs);
      const buffer = this.buffers.get(server.name);
      buffer.push(entries, now);
      const idle = this.idle.get(server.name);
      idle.update(entries, now);
      Object.assign(state, {
        connected: true,
        error: null,
        gpu: idle.annotate(entries, now),
        trends: buffer.getTrends(),
        historyByGpu: buffer.getHistoryByGpu(),
        gpuProcesses: buildGpuProcesses(this.baseProcesses.get(server.name) || [], mig.byGpu),
        timestamp: Date.now(),
      });
      this.notifier?.observe(server.name, { ok: true, entries: state.gpu, now });
    } catch (err) {
      Object.assign(state, { connected: false, error: err.message, timestamp: Date.now() });
      this.notifier?.observe(server.name, { ok: false, error: err.message, now: Date.now() });
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
      // user:64 -- plain `user` truncates names over 8 chars (e.g. "f.manzon+").
      const psOut = await ssh.exec(`ps -o pid=,user:64=,args= -p ${pids.join(',')}`);
      const byPid = parsePsOutput(psOut);
      for (const p of processes) {
        const info = byPid.get(p.pid);
        if (info) {
          p.owner = info.user;
          p.fullCommand = info.args;
          if (Object.hasOwn(this.config.userAvatars, info.user)) {
            p.avatarUrl = `/avatars/${encodeURIComponent(info.user)}`;
          }
        }
      }
    } catch {
      // leave processes without owner/args
    }
  }

  // Fails independently of the GPU poll: a missing process listing just empties the list
  // and never affects the server's overall `connected` status.
  async _pollGpuProcesses(ssh) {
    try {
      const [uuidOut, procOut] = await Promise.all([
        ssh.exec(this.config.gpuUuidQueryCommand),
        ssh.exec(this.config.gpuProcessesQueryCommand),
      ]);
      const processes = parseGpuProcesses(procOut, uuidOut);
      await this._attachProcessOwners(ssh, processes);
      return processes;
    } catch {
      return [];
    }
  }

  // Never throws and never touches `connected`. A failed XML query drops that GPU back to a
  // single n/a entry; any DCGM failure keeps the previous readings (staleness nulls them).
  async _pollMig(ssh, serverName, gpuIndexes) {
    try {
      let mig = this.mig.get(serverName);
      if (!mig) this.mig.set(serverName, (mig = { byGpu: new Map(), util: new Map(), gen: new Map() }));
      const gens = new Map(gpuIndexes.map((i) => [i, mig.gen.get(i) || 0]));
      for (const [i, g] of gens) mig.gen.set(i, g);
      const fresh = (i) => mig.gen.get(i) === gens.get(i);
      await Promise.all(
        gpuIndexes.map(async (i) => {
          try {
            const parsed = parseMigXml(await ssh.exec(this.config.migQueryCommand.replace('{gpu}', i)));
            await this._attachProcessOwners(ssh, parsed.processes);
            if (fresh(i)) mig.byGpu.set(i, parsed);
          } catch {
            if (fresh(i)) mig.byGpu.delete(i);
          }
        })
      );
      const wanted = [];
      for (const [gpuId, m] of mig.byGpu) {
        if (m.migEnabled) for (const d of m.devices) wanted.push(`${gpuId}/${d.gpuInstanceId}`);
      }
      if (!wanted.length) return;
      try {
        const discovery = parseDcgmDiscovery(await ssh.exec(this.config.dcgmDiscoveryCommand));
        const entityOf = new Map(wanted.filter((k) => discovery.has(k)).map((k) => [k, discovery.get(k)]));
        if (!entityOf.size) return;
        const entities = [...entityOf.values()].map((e) => `i:${e}`).join(',');
        const dmon = parseDcgmDmon(await ssh.exec(this.config.dcgmActivityCommand.replace('{entities}', entities)));
        const at = Date.now();
        for (const [k, e] of entityOf) {
          if (dmon.has(e) && fresh(Number(k.split('/')[0]))) mig.util.set(k, { value: dmon.get(e), at });
        }
      } catch {
        // keep previous readings
      }
    } catch {
      // never propagate
    }
  }

  // Docker listings change slowly, so this rides the same interval as the disk poll
  // instead of its own timer. A failure here doesn't affect the server's overall
  // `connected` status (GPU/disk polls own that).
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

    state.timestamp = Date.now();
    this.emit('update', { ...state });
  }

  getSnapshot() {
    return [...this.state.values()];
  }
}

module.exports = { Collector };
