const fs = require('fs');
const path = require('path');

const VERSION = 1;

// Loads { [serverName]: gpuStates } from the idle history file. Never throws: a missing file is
// a fresh start, and an unreadable one is moved aside (not deleted) so the dashboard still starts.
function load(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`idle history: cannot read ${filePath} (${err.message}); starting empty`);
    return {};
  }
  try {
    const data = JSON.parse(raw);
    const servers = data && data.version === VERSION ? data.servers : null;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('unrecognized format');
    return servers;
  } catch (err) {
    const backup = `${filePath}.corrupt-${Date.now()}`;
    console.warn(`idle history: ${filePath} is unreadable (${err.message}); moved to ${backup}, starting empty`);
    try {
      fs.renameSync(filePath, backup);
    } catch {
      // best effort: the next save overwrites it anyway
    }
    return {};
  }
}

// Write-then-rename so a crash mid-write never leaves a half-written file behind.
function save(filePath, servers) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, servers }));
  fs.renameSync(tmp, filePath);
}

module.exports = { load, save };
