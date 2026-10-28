// Renders a HostPoller snapshot in the Prometheus text exposition format. Unknown values produce
// no series at all (never 0), so the dashboard reads a missing series as "unknown". Results older
// than their stale limit are left out the same way. The `server` label is added by Prometheus.

const COMMAND_MAX = 500;

const METRICS = {
  nvtop_gpu_info: 'GPU entry (whole GPU or MIG partition); always 1.',
  nvtop_gpu_utilization_percent: 'GPU utilization (nvidia-smi), or graphics activity x 100 for a MIG partition (DCGM 1001).',
  nvtop_gpu_memory_used_mib: 'GPU memory used, MiB.',
  nvtop_gpu_memory_total_mib: 'GPU memory total, MiB.',
  nvtop_gpu_temperature_celsius: 'GPU temperature; partitions repeat their GPU.',
  nvtop_gpu_process_memory_mib: 'GPU memory used by one process on one GPU entry, MiB.',
  nvtop_container_created_timestamp_seconds: 'Running container, valued with its creation time.',
  nvtop_disk_size_kib: 'Filesystem size, KiB (df).',
  nvtop_disk_used_kib: 'Filesystem used, KiB (df).',
  nvtop_disk_usage_percent: 'Filesystem capacity used, percent (df).',
  nvtop_disk_top_folder_kib: 'Biggest immediate subfolder of the mount found by a time-limited du scan, KiB.',
  nvtop_poll_success: 'Whether the last run of this poll succeeded.',
  nvtop_poll_last_success_timestamp_seconds: 'When this poll last succeeded, by this host clock.',
};

const escape = (v) => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');

function renderMetrics(snapshot, { now = Date.now(), gpuStaleMs, processesStaleMs, diskStaleMs }) {
  const lines = new Map(Object.keys(METRICS).map((name) => [name, new Map()]));
  // Duplicate series would make Prometheus reject the whole scrape: the first one wins.
  const add = (name, labels, value) => {
    if (!Number.isFinite(value)) return;
    const body = Object.entries(labels).map(([k, v]) => `${k}="${escape(v)}"`).join(',');
    const series = `${name}{${body}}`;
    if (!lines.get(name).has(series)) lines.get(name).set(series, `${series} ${value}`);
  };
  const current = (block, staleMs) => block.at !== null && now - block.at <= staleMs;

  const { gpu, processes, disk, containers } = snapshot;
  if (current(gpu, gpuStaleMs)) {
    for (const e of gpu.entries) {
      add('nvtop_gpu_info', {
        key: e.key,
        label: e.label,
        gpu: e.id,
        name: e.name,
        mig: e.mig ? 'true' : 'false',
        gpu_instance_id: e.mig ? e.gpuInstanceId : '',
        unified_memory: e.unifiedMemory ? 'true' : 'false',
      }, 1);
      add('nvtop_gpu_utilization_percent', { key: e.key }, e.utilization ?? NaN);
      add('nvtop_gpu_memory_used_mib', { key: e.key }, e.memory.used ?? NaN);
      add('nvtop_gpu_memory_total_mib', { key: e.key }, e.memory.total ?? NaN);
      add('nvtop_gpu_temperature_celsius', { key: e.key }, e.temperature ?? NaN);
    }
  }
  if (current(processes, processesStaleMs)) {
    for (const p of processes.list) {
      add('nvtop_gpu_process_memory_mib', {
        key: p.gpuKey,
        gpu: p.gpuId,
        pid: p.pid,
        user: p.owner || '',
        process: p.process,
        command: String(p.fullCommand || '').slice(0, COMMAND_MAX),
      }, p.memoryUsedMb);
    }
  }
  if (current(containers, diskStaleMs)) {
    for (const c of containers.list) add('nvtop_container_created_timestamp_seconds', { name: c.name, status: c.status }, c.created);
  }
  if (current(disk, diskStaleMs)) {
    for (const v of disk.volumes) {
      add('nvtop_disk_size_kib', { mountpoint: v.mountpoint, filesystem: v.filesystem }, v.total);
      add('nvtop_disk_used_kib', { mountpoint: v.mountpoint }, v.used);
      add('nvtop_disk_usage_percent', { mountpoint: v.mountpoint }, v.usagePercent);
      if (v.topFolder) add('nvtop_disk_top_folder_kib', { mountpoint: v.mountpoint, path: v.topFolder.path }, v.topFolder.sizeKb);
    }
  }
  for (const [poll, block] of Object.entries({ gpu, processes, mig: snapshot.mig, disk, containers })) {
    if (block.ok !== null) add('nvtop_poll_success', { poll }, block.ok ? 1 : 0);
    if (block.at !== null) add('nvtop_poll_last_success_timestamp_seconds', { poll }, block.at / 1000);
  }

  let out = '';
  for (const [name, series] of lines) {
    if (!series.size) continue;
    out += `# HELP ${name} ${METRICS[name]}\n# TYPE ${name} gauge\n${[...series.values()].join('\n')}\n`;
  }
  return out;
}

module.exports = { renderMetrics, COMMAND_MAX };
