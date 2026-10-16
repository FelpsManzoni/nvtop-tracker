const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  servers: [],
  port: 3000,
  gpuPollIntervalMs: 2000,
  diskPollIntervalMs: 300000,
  gpuHistoryMinutes: 5,
  diskStorageAlertThreshold: 85,
  sshRetryMaxAttempts: 3,
  sshRetryDelayMs: 5000,
  gpuQueryCommand:
    'nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits',
  diskQueryCommand: 'df -kPT',
  dockerQueryCommand: 'docker ps --format "{{.Names}}\t{{.Status}}"',
  dockerImagesQueryCommand: 'docker images --format "{{.Repository}}:{{.Tag}}\t{{.CreatedSince}}"',
  gpuUuidQueryCommand: 'nvidia-smi --query-gpu=index,uuid --format=csv,noheader',
  gpuProcessesQueryCommand:
    'nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader',
  // Mounts equal to (or nested under) one of these prefixes get a "top offending folder" scan.
  diskTopFolderMountPrefixes: ['/data'],
  duTimeoutSeconds: 25,
  // Linux username -> image path (relative to the repo root, or absolute), served at /avatars/<user>.
  userAvatars: {},
  // Where per-GPU idle history is persisted (relative to the repo root, or absolute).
  idleHistoryFile: 'data/idle-history.json',
};

function loadConfig(configPath = path.join(__dirname, '..', 'config.json')) {
  let userConfig = {};
  if (fs.existsSync(configPath)) {
    userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  const config = { ...DEFAULTS, ...userConfig };
  const avatars = config.userAvatars;
  if (!avatars || typeof avatars !== 'object' || Array.isArray(avatars) ||
      Object.values(avatars).some((v) => typeof v !== 'string')) {
    throw new Error('config.userAvatars must be an object mapping usernames to image paths');
  }
  if (typeof config.idleHistoryFile !== 'string' || !config.idleHistoryFile) {
    throw new Error('config.idleHistoryFile must be a non-empty file path');
  }
  return config;
}

module.exports = { loadConfig, DEFAULTS };
