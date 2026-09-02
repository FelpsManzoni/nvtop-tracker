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
    'nvidia-smi --query-gpu=index,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits',
  diskQueryCommand: 'df -kPT',
};

function loadConfig(configPath = path.join(__dirname, '..', 'config.json')) {
  let userConfig = {};
  if (fs.existsSync(configPath)) {
    userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  return { ...DEFAULTS, ...userConfig };
}

module.exports = { loadConfig, DEFAULTS };
