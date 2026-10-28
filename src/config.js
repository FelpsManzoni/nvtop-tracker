const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // Each name must equal the `server` label Prometheus puts on that host's nvtop-exporter series.
  servers: [],
  port: 3000,
  // The Prometheus fed by nvtop-exporter. Credentials come from PROMETHEUS_USERNAME / PROMETHEUS_PASSWORD.
  prometheusUrl: 'http://127.0.0.1:19090',
  gpuPollIntervalMs: 2000,
  gpuHistoryMinutes: 5,
  // A server whose exporter has not had a successful GPU poll for this long shows offline.
  staleAfterMs: 10000,
  diskStorageAlertThreshold: 85,
  // Linux username -> image path (relative to the repo root, or absolute), served at /avatars/<user>.
  userAvatars: {},
  // Where per-GPU idle history is persisted (relative to the repo root, or absolute).
  idleHistoryFile: 'data/idle-history.json',
  // Teams Workflows webhook for idle/down alerts; empty disables notifications. Never logged or sent to the browser.
  teamsWebhookUrl: '',
};

function loadConfig(configPath = process.env.NVTOP_CONFIG || path.join(__dirname, '..', 'config.json'), env = process.env) {
  let userConfig = {};
  if (fs.existsSync(configPath)) {
    userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  const config = { ...DEFAULTS, ...userConfig };
  if (!Array.isArray(config.servers) || config.servers.some((s) => !s || typeof s.name !== 'string' || !s.name)) {
    throw new Error('config.servers must be a list of { "name": "<server label>" }');
  }
  const avatars = config.userAvatars;
  if (!avatars || typeof avatars !== 'object' || Array.isArray(avatars) ||
      Object.values(avatars).some((v) => typeof v !== 'string')) {
    throw new Error('config.userAvatars must be an object mapping usernames to image paths');
  }
  if (typeof config.idleHistoryFile !== 'string' || !config.idleHistoryFile) {
    throw new Error('config.idleHistoryFile must be a non-empty file path');
  }
  const hook = config.teamsWebhookUrl;
  if (typeof hook !== 'string' || (hook && (!hook.startsWith('https://') || hook.includes('\\')))) {
    throw new Error('config.teamsWebhookUrl must be an https URL without backslashes');
  }
  if (typeof config.prometheusUrl !== 'string' || !/^https?:\/\/[^/]/.test(config.prometheusUrl)) {
    throw new Error('config.prometheusUrl must be an http(s) URL');
  }
  // Kept out of config.json so the repo and the config file never hold them.
  config.prometheusAuth = env.PROMETHEUS_USERNAME
    ? { username: env.PROMETHEUS_USERNAME, password: env.PROMETHEUS_PASSWORD || '' }
    : {};
  return config;
}

module.exports = { loadConfig, DEFAULTS };
