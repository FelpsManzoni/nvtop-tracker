const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // The exporter is only scraped by the Prometheus next to it: keep it off the network.
  listenHost: '127.0.0.1',
  listenPort: 19101,
  gpuPollIntervalMs: 2000,
  diskPollIntervalMs: 300000,
  gpuQueryCommand:
    'nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits',
  diskQueryCommand: 'df -kPT',
  gpuUuidQueryCommand: 'nvidia-smi --query-gpu=index,uuid --format=csv,noheader',
  gpuProcessesQueryCommand:
    'nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader',
  // MIG partitions: {gpu} is one GPU index, {entities} is e.g. i:49,i:50 (GPU-instance entity ids).
  migQueryCommand: 'timeout 10 nvidia-smi -q -x -i {gpu}',
  dcgmDiscoveryCommand: 'timeout 10 dcgmi discovery -c',
  // Fields, in this order: 1001 graphics activity, 250 framebuffer total, 252 framebuffer used (MiB).
  dcgmActivityCommand: 'timeout 10 dcgmi dmon -e 1001,250,252 -c 2 -d 1000 -i {entities}',
  // Only mounts equal to (or nested under) one of these are reported; null reports every real
  // mount and [] none. In a container this keeps its own bind mounts (/etc/passwd, /etc/hosts) out.
  diskMountPrefixes: null,
  // Mounts equal to (or nested under) one of these get a "top offending folder" scan.
  diskTopFolderMountPrefixes: ['/data'],
  duTimeoutSeconds: 25,
  // Docker Engine API for the running-containers list: unix:///path/to.sock or http://host:port.
  // Empty disables the containers poll.
  dockerHost: 'unix:///var/run/docker.sock',
  // Jetson-style GPUs share system memory and report it as [N/A]: read /proc/meminfo instead.
  unifiedMemoryFallback: false,
  meminfoPath: '/proc/meminfo',
};

const isStringList = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.startsWith('/'));

function loadExporterConfig(
  configPath = process.env.NVTOP_EXPORTER_CONFIG || path.join(__dirname, '..', 'exporter.config.json')
) {
  let userConfig = {};
  if (fs.existsSync(configPath)) {
    userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  const config = { ...DEFAULTS, ...userConfig };
  if (config.diskMountPrefixes !== null && !isStringList(config.diskMountPrefixes)) {
    throw new Error('exporter config: diskMountPrefixes must be null or a list of absolute paths');
  }
  if (!isStringList(config.diskTopFolderMountPrefixes)) {
    throw new Error('exporter config: diskTopFolderMountPrefixes must be a list of absolute paths');
  }
  if (!Number.isInteger(config.listenPort) || config.listenPort < 1 || config.listenPort > 65535) {
    throw new Error('exporter config: listenPort must be a TCP port number');
  }
  const docker = config.dockerHost;
  if (typeof docker !== 'string' || (docker && !/^(unix:\/\/\/|http:\/\/)/.test(docker))) {
    throw new Error('exporter config: dockerHost must be unix:///path, http://host:port, or empty');
  }
  return config;
}

module.exports = { loadExporterConfig, DEFAULTS };
