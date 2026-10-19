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

// Root and everything under /boot (including /boot/efi) are always excluded from disk
// tracking -- noisy, not actionable capacity.
function isExcludedMountpoint(mountpoint) {
  return mountpoint === '/' || mountpoint === '/boot' || mountpoint.startsWith('/boot/');
}

// Parses `nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits`
function parseGpuCsv(output) {
  const gpus = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(',').map((s) => s.trim());
    if (parts.length !== 6) continue;
    const [idStr, name, utilStr, memUsedStr, memTotalStr, tempStr] = parts;
    const num = (str) => (str === '' ? NaN : Number(str)); // Number('') is 0, which would fake telemetry
    const [id, memUsed, memTotal, temperature] = [idStr, memUsedStr, memTotalStr, tempStr].map(num);
    // Utilization may be "[N/A]" (e.g. MIG-enabled GPUs) or otherwise unusable: keep the GPU with null.
    const u = num(utilStr);
    const utilization = Number.isFinite(u) && u >= 0 && u <= 100 ? u : null;
    if (!name || [id, memUsed, memTotal, temperature].some(Number.isNaN)) continue;
    gpus.push({
      id,
      key: String(id),
      label: `GPU ${id}`,
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
      gpuKey: String(uuidToIndex.get(uuid)),
      gpuLabel: `GPU ${uuidToIndex.get(uuid)}`,
      pid: Number(pidStr),
      process: processPath.split('/').pop(),
      fullCommand: processPath,
      memoryUsedMb,
    });
  }
  return processes;
}

// Parses `ps -o pid=,user=,args= -p <pids>` output ("<pid> <user> <full command with args>" per
// line) into a pid -> {user, args} map, used to enrich GPU process rows with owner and the real
// full command (nvidia-smi's process_name is just the binary path, no args).
function parsePsOutput(output) {
  const byPid = new Map();
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const [, pidStr, user, args] = match;
    byPid.set(Number(pidStr), { user, args });
  }
  return byPid;
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
    const mountpoint = mountParts.join(' ');
    if (isExcludedMountpoint(mountpoint)) continue;
    const usagePercent = parseInt(capacity, 10);
    if (Number.isNaN(usagePercent)) continue;
    volumes.push({
      filesystem,
      mountpoint,
      used: Number(usedBlocks),
      total: Number(totalBlocks),
      usagePercent,
      alert: usagePercent >= alertThreshold,
    });
  }
  return volumes;
}

// Parses `du -x -k --max-depth=1 <mountpoint>` output ("<sizeKb>\t<path>" per line) and
// returns the largest immediate subfolder, excluding the grand-total line for the mount
// itself. Lines that don't match (e.g. "du: cannot read directory ...: Permission denied"
// warnings on stderr-as-stdout in some shells, or a scan cut short by a timeout) are skipped.
function parseDuTopFolder(output, mountpoint) {
  let best = null;
  for (const line of output.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const sizeKb = Number(line.slice(0, tab).trim());
    const path = line.slice(tab + 1).trim();
    if (Number.isNaN(sizeKb) || !path || path === mountpoint) continue;
    if (!best || sizeKb > best.sizeKb) best = { path, sizeKb };
  }
  return best;
}

const mib = (v) => parseInt(v, 10);
const tag = (block, name) => (block.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`)) || [])[1];

// Parses single-GPU `nvidia-smi -q -x` output: MIG partitions (framebuffer memory) and processes.
function parseMigXml(xml) {
  const result = { migEnabled: false, devices: [], processes: [] };
  if (typeof xml !== 'string') return result;
  result.migEnabled = tag(xml, 'current_mig') === 'Enabled';
  for (const m of xml.matchAll(/<mig_device>([\s\S]*?)<\/mig_device>/g)) {
    const fb = (m[1].match(/<fb_memory_usage>([\s\S]*?)<\/fb_memory_usage>/) || [])[1] || '';
    const dev = {
      migIndex: Number(tag(m[1], 'index')),
      gpuInstanceId: Number(tag(m[1], 'gpu_instance_id')),
      memory: { used: mib(tag(fb, 'used')), total: mib(tag(fb, 'total')) },
    };
    if (Number.isNaN(dev.migIndex) || Number.isNaN(dev.gpuInstanceId) || Number.isNaN(dev.memory.used) || Number.isNaN(dev.memory.total)) continue;
    result.devices.push(dev);
  }
  for (const m of xml.matchAll(/<process_info>([\s\S]*?)<\/process_info>/g)) {
    const gi = Number(tag(m[1], 'gpu_instance_id'));
    const name = tag(m[1], 'process_name') || '';
    const pid = Number(tag(m[1], 'pid'));
    const memoryUsedMb = mib(tag(m[1], 'used_memory'));
    if (Number.isNaN(pid) || Number.isNaN(memoryUsedMb)) continue;
    result.processes.push({
      gpuInstanceId: Number.isNaN(gi) ? null : gi,
      pid,
      process: name.split('/').pop(),
      fullCommand: name,
      memoryUsedMb,
    });
  }
  return result;
}

// Parses `dcgmi discovery -c`: "<gpu>/<gpuInstance>" -> GPU-instance entity id.
function parseDcgmDiscovery(output) {
  const map = new Map();
  for (const m of output.matchAll(/I\s+(\d+)\/(\d+)\s*\|.*EntityID:\s*(\d+)/g)) map.set(`${m[1]}/${m[2]}`, Number(m[3]));
  return map;
}

// Parses `dcgmi dmon` output ("GPU-I <id> <value>" rows): entity id -> last numeric value.
function parseDcgmDmon(output) {
  const map = new Map();
  for (const m of output.matchAll(/^\s*GPU-I\s+(\d+)\s+(\S+)/gm)) {
    const value = Number(m[2]);
    if (Number.isFinite(value)) map.set(Number(m[1]), value);
  }
  return map;
}

module.exports = {
  parseMigXml,
  parseDcgmDiscovery,
  parseDcgmDmon,
  parseGpuCsv,
  parseDf,
  parseDockerPs,
  parseDockerImages,
  parseGpuProcesses,
  parseDuTopFolder,
  parsePsOutput,
};
