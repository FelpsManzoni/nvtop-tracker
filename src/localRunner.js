const { execFile } = require('child_process');

// Runs a command line through /bin/sh on this machine, the way the dashboard used to run it
// remotely over SSH. No retries: every poll runs again on its next interval anyway.
function createLocalRunner({ timeoutMs = 40000 } = {}) {
  return (command) =>
    new Promise((resolve, reject) => {
      execFile('/bin/sh', ['-c', command], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr.trim() || err.message));
        resolve(stdout);
      });
    });
}

module.exports = { createLocalRunner };
