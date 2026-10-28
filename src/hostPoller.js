const fs = require('fs');
const {
  parseGpuCsv,
  parseDf,
  parseGpuProcesses,
  parseDuTopFolder,
  parsePsOutput,
  parseMigXml,
  parseDcgmDiscovery,
  parseDcgmDmonFields,
  parseMeminfo,
} = require('./parsers');
const { buildGpuEntries, buildGpuProcesses } = require('./mig');

function isUnder(mountpoint, prefixes) {
  return prefixes.some((prefix) => mountpoint === prefix || mountpoint.startsWith(`${prefix}/`));
}

function shellQuote(str) {
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

// Partition layout of one GPU as DCGM sees it, ordered like nvidia-smi's MIG device index.
// DCGM has no per-partition memory or processes here; the activity poll fills the memory in.
function dcgmLayout(discovery, gpuId) {
  const instances = [...discovery.keys()]
    .filter((k) => k.startsWith(`${gpuId}/`))
    .map((k) => Number(k.split('/')[1]))
    .sort((a, b) => a - b);
  if (!instances.length) return null;
  return {
    migEnabled: true,
    source: 'dcgm',
    devices: instances.map((gpuInstanceId, migIndex) => ({ migIndex, gpuInstanceId, memory: { used: null, total: null } })),
    processes: [],
  };
}

// Collects what the dashboard shows for the machine it runs on, with the same commands the
// dashboard used to run over SSH. Each poll keeps its last result and when it last succeeded;
// metrics.js turns a snapshot of that into Prometheus series, so a scrape never runs a command.
// `ok` is null until a poll has been attempted.
class HostPoller {
  constructor(config, { run, listContainers = null, readFile = fs.readFileSync }) {
    this.config = config;
    this.run = run;
    this.listContainers = listContainers;
    this.readFile = readFile;
    this.gpu = { ok: null, error: null, at: null, entries: [] };
    this.processes = { ok: null, at: null, base: [] };
    this.migPoll = { ok: null, at: null };
    this.disk = { ok: null, error: null, at: null, volumes: [] };
    this.containers = { ok: null, error: null, at: null, list: [] };
    this.mig = { byGpu: new Map(), util: new Map(), gen: new Map() }; // gen fences off stale MIG polls
    this.inFlight = new Set();
    this.timers = [];
  }

  start() {
    this.pollGpu();
    this.pollDisk();
    this.pollContainers();
    this.timers.push(setInterval(() => this.pollGpu(), this.config.gpuPollIntervalMs));
    this.timers.push(
      setInterval(() => {
        this.pollDisk();
        this.pollContainers();
      }, this.config.diskPollIntervalMs)
    );
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  snapshot() {
    return {
      gpu: this.gpu,
      processes: { ...this.processes, list: buildGpuProcesses(this.processes.base, this.mig.byGpu) },
      mig: this.migPoll,
      disk: this.disk,
      containers: this.containers,
    };
  }

  // At most one run of each poll at a time: a hung command (e.g. nvidia-smi on a faulted GPU)
  // must not let runs pile up every interval.
  async _once(kind, fn) {
    if (this.inFlight.has(kind)) return;
    this.inFlight.add(kind);
    try {
      await fn();
    } finally {
      this.inFlight.delete(kind);
    }
  }

  pollGpu() {
    return this._once('gpu', async () => {
      // GPU processes ride the GPU poll so owners stay as fresh as the utilization numbers, but
      // are not awaited: a slow/hung process query never delays GPU telemetry.
      this._once('processes', () => this._pollProcesses());
      try {
        const gpus = parseGpuCsv(await this.run(this.config.gpuQueryCommand));
        if (this.config.unifiedMemoryFallback) this._fillUnifiedMemory(gpus);
        const now = Date.now();
        const naGpus = gpus.filter((g) => g.utilization === null).map((g) => g.id);
        if (naGpus.length) this._once('mig', () => this._pollMig(naGpus));
        this._forgetMig(new Set(naGpus));
        const entries = buildGpuEntries(gpus, this.mig.byGpu, this.mig.util, now, 3 * this.config.gpuPollIntervalMs);
        this.gpu = { ok: true, error: null, at: now, entries };
      } catch (err) {
        this.gpu = { ...this.gpu, ok: false, error: err.message };
      }
    });
  }

  // Forget MIG state for GPUs that are numeric again or no longer listed.
  _forgetMig(stillNa) {
    const mig = this.mig;
    for (const id of new Set([...mig.byGpu.keys(), ...mig.gen.keys()])) {
      if (stillNa.has(id)) continue;
      mig.gen.set(id, (mig.gen.get(id) || 0) + 1); // in-flight MIG polls for this GPU are now stale
      mig.byGpu.delete(id);
      for (const k of [...mig.util.keys()]) if (k.startsWith(`${id}/`)) mig.util.delete(k);
    }
  }

  // GPUs that share system memory get it from /proc/meminfo; if that fails too, memory stays unknown.
  _fillUnifiedMemory(gpus) {
    const missing = gpus.filter((g) => g.memory.used === null || g.memory.total === null);
    if (!missing.length) return;
    let memory = null;
    try {
      memory = parseMeminfo(this.readFile(this.config.meminfoPath, 'utf8'));
    } catch {
      // stays unknown
    }
    if (!memory) return;
    for (const g of missing) Object.assign(g, { memory, unifiedMemory: true });
  }

  // A failed listing empties the list, as it did over SSH; it never affects the GPU poll.
  async _pollProcesses() {
    try {
      const [uuidOut, procOut] = await Promise.all([
        this.run(this.config.gpuUuidQueryCommand),
        this.run(this.config.gpuProcessesQueryCommand),
      ]);
      const base = parseGpuProcesses(procOut, uuidOut);
      await this._attachProcessOwners(base);
      this.processes = { ok: true, at: Date.now(), base };
    } catch {
      this.processes = { ...this.processes, ok: false, base: [] };
    }
  }

  // Best-effort: nvidia-smi only gives the binary path, not the args or the owning user.
  // `ps` fills those in, keyed by pid; a process that already exited between the two
  // queries just keeps nvidia-smi's bare binary path and no owner.
  async _attachProcessOwners(processes) {
    if (!processes.length) return;
    try {
      const pids = [...new Set(processes.map((p) => p.pid))];
      // user:64 -- plain `user` truncates names over 8 chars (e.g. "j.silva.+").
      const byPid = parsePsOutput(await this.run(`ps -o pid=,user:64=,args= -p ${pids.join(',')}`));
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

  // Never throws. Layout, memory and processes of partitions come from the nvidia-smi XML. When
  // the XML can't be read, or shows MIG enabled but lists no partitions (how a container without
  // the MIG monitor capability sees them), the layout comes from DCGM, which runs on the host and
  // always sees them. Any DCGM failure keeps the previous readings (staleness nulls them).
  async _pollMig(gpuIndexes) {
    const mig = this.mig;
    const gens = new Map(gpuIndexes.map((i) => [i, mig.gen.get(i) || 0]));
    for (const [i, g] of gens) mig.gen.set(i, g);
    const fresh = (i) => mig.gen.get(i) === gens.get(i);
    let ok = true;
    try {
      const xml = new Map(); // gpu -> parsed XML, null when the query failed
      await Promise.all(
        gpuIndexes.map(async (i) => {
          try {
            const parsed = parseMigXml(await this.run(this.config.migQueryCommand.replace('{gpu}', i)));
            await this._attachProcessOwners(parsed.processes);
            xml.set(i, parsed);
          } catch {
            xml.set(i, null);
            ok = false;
          }
        })
      );
      const hidden = (p) => !p || (p.migEnabled && !p.devices.length);
      let discovery = null;
      if (gpuIndexes.some((i) => hidden(xml.get(i)) || xml.get(i).migEnabled)) {
        try {
          discovery = parseDcgmDiscovery(await this.run(this.config.dcgmDiscoveryCommand));
        } catch {
          ok = false;
        }
      }
      for (const i of gpuIndexes) {
        if (!fresh(i)) continue;
        const parsed = xml.get(i);
        const layout = hidden(parsed) ? (discovery && dcgmLayout(discovery, i)) || parsed : parsed;
        if (layout) mig.byGpu.set(i, layout.source ? layout : { ...layout, source: 'xml' });
        else mig.byGpu.delete(i); // no XML and DCGM knows no partitions: a single n/a entry
      }

      const wanted = [];
      for (const [gpuId, m] of mig.byGpu) {
        if (m.migEnabled) for (const d of m.devices) wanted.push(`${gpuId}/${d.gpuInstanceId}`);
      }
      const entityOf = new Map(wanted.filter((k) => discovery && discovery.has(k)).map((k) => [k, discovery.get(k)]));
      if (entityOf.size) {
        try {
          const entities = [...entityOf.values()].map((e) => `i:${e}`).join(',');
          const dmon = parseDcgmDmonFields(await this.run(this.config.dcgmActivityCommand.replace('{entities}', entities)));
          const at = Date.now();
          for (const [k, e] of entityOf) {
            const row = dmon.get(e);
            if (!row || !fresh(Number(k.split('/')[0]))) continue;
            const [value = null, total = null, used = null] = row;
            mig.util.set(k, { value, at, memory: total !== null && used !== null ? { used, total } : undefined });
          }
        } catch {
          ok = false; // keep previous readings
        }
      }
    } catch {
      ok = false; // never propagate
    }
    this.migPoll = { ok, at: ok ? Date.now() : this.migPoll.at };
  }

  pollDisk() {
    return this._once('disk', async () => {
      try {
        const prefixes = this.config.diskMountPrefixes;
        const volumes = parseDf(await this.run(this.config.diskQueryCommand), Infinity)
          .filter((v) => prefixes === null || isUnder(v.mountpoint, prefixes))
          .map(({ alert, ...v }) => v); // the alert threshold is the dashboard's business
        await Promise.all(
          volumes
            .filter((v) => isUnder(v.mountpoint, this.config.diskTopFolderMountPrefixes))
            .map((v) => this._attachTopFolder(v))
        );
        this.disk = { ok: true, error: null, at: Date.now(), volumes };
      } catch (err) {
        this.disk = { ...this.disk, ok: false, error: err.message };
      }
    });
  }

  // Best-effort: on a large/busy filesystem the scan can time out before finishing, in
  // which case the reported "top folder" is only the biggest among whatever got scanned,
  // not necessarily the true biggest.
  async _attachTopFolder(volume) {
    try {
      const du = `timeout ${this.config.duTimeoutSeconds} du -x -k --max-depth=1 ${shellQuote(volume.mountpoint)} ; true`;
      volume.topFolder = parseDuTopFolder(await this.run(du), volume.mountpoint);
    } catch {
      volume.topFolder = null;
    }
  }

  pollContainers() {
    if (!this.listContainers) return Promise.resolve();
    return this._once('containers', async () => {
      try {
        this.containers = { ok: true, error: null, at: Date.now(), list: await this.listContainers() };
      } catch (err) {
        this.containers = { ...this.containers, ok: false, error: err.message };
      }
    });
  }
}

module.exports = { HostPoller };
