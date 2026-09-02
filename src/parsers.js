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
  'efivarfs',
]);

// Parses `nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits`
function parseGpuCsv(output) {
  const gpus = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length !== 6) continue;
    const [idStr, name, utilStr, memUsedStr, memTotalStr, tempStr] = parts;
    const [id, utilization, memUsed, memTotal, temperature] = [idStr, utilStr, memUsedStr, memTotalStr, tempStr].map(
      Number
    );
    if (!name || [id, utilization, memUsed, memTotal, temperature].some(Number.isNaN)) continue;
    gpus.push({
      id,
      name,
      utilization,
      memory: { used: memUsed, total: memTotal },
      temperature,
    });
  }
  return gpus;
}

// Parses `docker ps --format "{{.Names}}\t{{.Status}}"` (running containers only)
function parseDockerPs(output) {
  const containers = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [name, status] = line.split('\t');
    if (!name || !status) continue;
    containers.push({ name, status });
  }
  return containers;
}

// Parses `docker images --format "{{.Repository}}:{{.Tag}}\t{{.CreatedSince}}"`, skipping dangling images
function parseDockerImages(output) {
  const images = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [repoTag, created] = line.split('\t');
    if (!repoTag || !created || repoTag.startsWith('<none>')) continue;
    images.push({ repoTag, created });
  }
  return images;
}

// Joins `nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader`
// against `nvidia-smi --query-gpu=index,uuid --format=csv,noheader` to resolve GPU index per process.
function parseGpuProcesses(processOutput, uuidOutput) {
  const uuidToIndex = new Map();
  for (const line of uuidOutput.split('\n')) {
    if (!line.trim()) continue;
    const [index, uuid] = line.split(',').map((s) => s.trim());
    if (index === undefined || !uuid) continue;
    uuidToIndex.set(uuid, Number(index));
  }

  const processes = [];
  for (const line of processOutput.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length !== 4) continue;
    const [uuid, pidStr, processPath, memoryStr] = parts;
    if (!uuidToIndex.has(uuid)) continue;
    const memoryUsedMb = parseInt(memoryStr, 10);
    if (Number.isNaN(memoryUsedMb)) continue;
    processes.push({
      gpuId: uuidToIndex.get(uuid),
      pid: Number(pidStr),
      process: processPath.split('/').pop(),
      fullCommand: processPath,
      memoryUsedMb,
    });
  }
  return processes;
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

module.exports = { parseGpuCsv, parseDf, parseDockerPs, parseDockerImages, parseGpuProcesses };
