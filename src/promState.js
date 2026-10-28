// Pure helpers turning nvtop-exporter series read from Prometheus into the per-server state the
// browser has always received. A missing series means "unknown" (null), never 0.
const { fmtDuration } = require('./teams');

// "7-2" -> 2, "7" -> 0: a whole GPU sorts before its partitions, partitions by number.
const partitionOf = (key) => Number(String(key).split('-')[1] || 0);
const labelFor = (key) => {
  const [gpu, n] = String(key).split('-');
  return n ? `GPU ${gpu} - ${n}` : `GPU ${gpu}`;
};

function byServer(series) {
  const map = new Map();
  for (const s of series) {
    const name = s.labels.server;
    if (!name) continue;
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(s);
  }
  return map;
}

const named = (series, name) => series.filter((s) => s.labels.__name__ === name);

function newEntry(labels) {
  const mig = labels.mig === 'true';
  return {
    id: Number(labels.gpu),
    key: labels.key,
    label: labels.label,
    name: labels.name,
    mig,
    ...(mig ? { gpuInstanceId: Number(labels.gpu_instance_id) } : {}),
    unifiedMemory: labels.unified_memory === 'true',
    utilization: null,
    memory: { used: null, total: null },
    temperature: null,
  };
}

const READINGS = {
  nvtop_gpu_utilization_percent: (e, v) => { e.utilization = v; },
  nvtop_gpu_memory_used_mib: (e, v) => { e.memory.used = v; },
  nvtop_gpu_memory_total_mib: (e, v) => { e.memory.total = v; },
  nvtop_gpu_temperature_celsius: (e, v) => { e.temperature = v; },
};

function gpuEntries(series) {
  const byKey = new Map(named(series, 'nvtop_gpu_info').map((s) => [s.labels.key, newEntry(s.labels)]));
  for (const { labels, value } of series) {
    const e = byKey.get(labels.key);
    if (e && READINGS[labels.__name__]) READINGS[labels.__name__](e, value);
  }
  return [...byKey.values()].sort((a, b) => a.id - b.id || partitionOf(a.key) - partitionOf(b.key));
}

function gpuProcesses(series, entries, userAvatars) {
  const labelOf = new Map(entries.map((e) => [e.key, e.label]));
  return named(series, 'nvtop_gpu_process_memory_mib')
    .map(({ labels, value }) => {
      const owner = labels.user || null;
      return {
        gpuId: Number(labels.gpu),
        gpuKey: labels.key,
        gpuLabel: labelOf.get(labels.key) || labelFor(labels.key),
        pid: Number(labels.pid),
        process: labels.process,
        fullCommand: labels.command,
        memoryUsedMb: value,
        ...(owner ? { owner } : {}),
        ...(owner && Object.hasOwn(userAvatars, owner) ? { avatarUrl: `/avatars/${encodeURIComponent(owner)}` } : {}),
      };
    })
    .sort((a, b) => a.gpuId - b.gpuId || partitionOf(a.gpuKey) - partitionOf(b.gpuKey) || a.pid - b.pid);
}

// Newest first, like `docker ps`.
function containers(series) {
  return named(series, 'nvtop_container_created_timestamp_seconds')
    .sort((a, b) => b.value - a.value || a.labels.name.localeCompare(b.labels.name))
    .map(({ labels }) => ({ name: labels.name, status: labels.status }));
}

function disks(series, alertThreshold) {
  const byMount = new Map();
  const volume = (mountpoint) => {
    if (!byMount.has(mountpoint)) {
      byMount.set(mountpoint, { filesystem: '', mountpoint, used: null, total: null, usagePercent: null, topFolder: null });
    }
    return byMount.get(mountpoint);
  };
  for (const { labels, value } of series) {
    switch (labels.__name__) {
      case 'nvtop_disk_size_kib': Object.assign(volume(labels.mountpoint), { total: value, filesystem: labels.filesystem }); break;
      case 'nvtop_disk_used_kib': volume(labels.mountpoint).used = value; break;
      case 'nvtop_disk_usage_percent': volume(labels.mountpoint).usagePercent = value; break;
      case 'nvtop_disk_top_folder_kib': volume(labels.mountpoint).topFolder = { path: labels.path, sizeKb: value }; break;
      default:
    }
  }
  return [...byMount.values()]
    .filter((v) => [v.used, v.total, v.usagePercent].every(Number.isFinite))
    .map((v) => ({ ...v, alert: v.usagePercent >= alertThreshold }))
    .sort((a, b) => a.mountpoint.localeCompare(b.mountpoint));
}

// GPU data is current while the exporter's GPU poll succeeded recently, by its own clock (both
// hosts are NTP-synchronized). The error text ends up in Teams' "Último erro" line.
function gpuFreshness(series, now, staleAfterMs) {
  const last = series.find(
    (s) => s.labels.__name__ === 'nvtop_poll_last_success_timestamp_seconds' && s.labels.poll === 'gpu'
  );
  if (!last) return { fresh: false, error: 'nenhum dado do exporter no Prometheus' };
  const age = now - last.value * 1000;
  if (age <= staleAfterMs) return { fresh: true, error: null };
  const ago = age < 60_000 ? `${Math.round(age / 1000)}s` : fmtDuration(age);
  return { fresh: false, error: `sem dados novos do exporter há ${ago}` };
}

// SSH reachability from the probe agent: up true/false, null when no probe reports this server.
function sshState(series) {
  const up = series.find((s) => s.labels.__name__ === 'nvtop_ssh_up');
  const took = series.find((s) => s.labels.__name__ === 'nvtop_ssh_probe_duration_seconds');
  if (!up) return { up: null, latencyMs: null };
  return { up: up.value === 1, latencyMs: up.value === 1 && took ? Math.round(took.value * 1000) : null };
}

function buildServerState(series, { now, staleAfterMs, diskAlertThreshold, userAvatars }) {
  const entries = gpuEntries(series);
  return {
    ...gpuFreshness(series, now, staleAfterMs),
    ssh: sshState(series),
    gpu: entries,
    gpuProcesses: gpuProcesses(series, entries, userAvatars),
    docker: { containers: containers(series), images: [] },
    disk: disks(series, diskAlertThreshold),
  };
}

// Range-query series of nvtop_gpu_info and the GPU readings -> per server, RollingBuffer samples
// in time order ({ timestamp, gpus }), each with every GPU entry known at that step.
function historySamples(rangeSeries) {
  const steps = new Map(); // server -> Map(timestamp -> Map(key -> entry))
  for (const { labels, points } of rangeSeries) {
    if (labels.__name__ !== 'nvtop_gpu_info' || !labels.server) continue;
    if (!steps.has(labels.server)) steps.set(labels.server, new Map());
    const byTime = steps.get(labels.server);
    for (const [t] of points) {
      if (!byTime.has(t)) byTime.set(t, new Map());
      byTime.get(t).set(labels.key, newEntry(labels));
    }
  }
  for (const { labels, points } of rangeSeries) {
    const apply = READINGS[labels.__name__];
    const byTime = steps.get(labels.server);
    if (!apply || !byTime) continue;
    for (const [t, v] of points) {
      const e = byTime.has(t) && byTime.get(t).get(labels.key);
      if (e) apply(e, v);
    }
  }
  const out = new Map();
  for (const [server, byTime] of steps) {
    out.set(
      server,
      [...byTime.entries()].sort(([a], [b]) => a - b).map(([timestamp, entries]) => ({ timestamp, gpus: [...entries.values()] }))
    );
  }
  return out;
}

module.exports = { byServer, buildServerState, historySamples, gpuFreshness, labelFor };
