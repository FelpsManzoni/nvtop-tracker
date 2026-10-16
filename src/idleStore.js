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
    if (err.code === 'ENOENT') return {};
    // Never move a directory aside (e.g. idleHistoryFile misconfigured as "data").
    if (err.code === 'EISDIR') {
      console.warn(`idle history: ${filePath} is a directory, not a file; leaving it in place and starting empty`);
      return {};
    }
    return discard(filePath, `cannot be read (${err.message})`);
  }
  try {
    const data = JSON.parse(raw);
    const servers = data && data.version === VERSION ? data.servers : null;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('unrecognized format');
    return servers;
  } catch (err) {
    return discard(filePath, `is unreadable (${err.message})`);
  }
}

// Moves a bad file aside (never deletes it) so the next save can't overwrite the only copy.
function discard(filePath, reason) {
  const backup = `${filePath}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(filePath, backup);
    console.warn(`idle history: ${filePath} ${reason}; moved to ${backup}, starting empty`);
  } catch (err) {
    console.warn(`idle history: ${filePath} ${reason}; could not move it aside (${err.message}), starting empty`);
  }
  return {};
}

// Write-then-rename so a crash mid-write never leaves a half-written file behind.
function save(filePath, servers) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, servers }));
  fs.renameSync(tmp, filePath);
}

module.exports = { load, save };
