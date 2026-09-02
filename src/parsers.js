const VIRTUAL_FS_TYPES = new Set([
  'tmpfs',
  'devtmpfs',
  'overlay',
  'squashfs',
  'proc',
  'sysfs',
  'cgroup',
  'cgroup2',
  'devpts',
  'mqueue',
  'debugfs',
  'tracefs',
  'securityfs',
  'pstore',
  'bpf',
  'autofs',
]);

// Parses `nvidia-smi --query-gpu=index,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits`
function parseGpuCsv(output) {
  const gpus = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length !== 5 || parts.some((p) => p === '' || Number.isNaN(Number(p)))) continue;
    const [id, utilization, memUsed, memTotal, temperature] = parts.map(Number);
    gpus.push({
      id,
      utilization,
      memory: { used: memUsed, total: memTotal },
      temperature,
    });
  }
  return gpus;
}

// Parses `df -kPT` output (POSIX format with filesystem type column, sizes in 1024-blocks)
function parseDf(output, alertThreshold) {
  const lines = output.split('\n').filter((l) => l.trim());
  const volumes = [];
  for (const line of lines.slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 7) continue;
    const [filesystem, type, totalBlocks, usedBlocks, , capacity, ...mountParts] = cols;
    if (VIRTUAL_FS_TYPES.has(type)) continue;
    const usagePercent = parseInt(capacity, 10);
    if (Number.isNaN(usagePercent)) continue;
    volumes.push({
      filesystem,
      mountpoint: mountParts.join(' '),
      used: Number(usedBlocks),
      total: Number(totalBlocks),
      usagePercent,
      alert: usagePercent >= alertThreshold,
    });
  }
  return volumes;
}

module.exports = { parseGpuCsv, parseDf };
