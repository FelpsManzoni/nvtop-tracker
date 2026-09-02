const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Shells out to the system `ssh` binary so auth, user, port, and identity all
// resolve exactly like `ssh <host>` on the command line (~/.ssh/config, agent,
// ProxyJump, etc.) instead of reimplementing SSH auth resolution ourselves.
// ControlMaster/ControlPersist gives us connection reuse across polls for free.
class SSHManager {
  constructor(serverConfig, { maxAttempts = 3, retryDelayMs = 5000, execFn } = {}) {
    this.config = serverConfig;
    this.maxAttempts = maxAttempts;
    this.retryDelayMs = retryDelayMs;
    this.connected = false;
    this._execFn = execFn || ((command) => this._realExec(command));
    const hash = crypto.createHash('md5').update(serverConfig.host).digest('hex').slice(0, 8);
    this.controlPath = path.join(os.tmpdir(), `nvtop-tracker-${hash}.sock`);
  }

  _sshArgs(command) {
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'ControlMaster=auto',
      '-o', 'ControlPersist=60s',
      '-o', `ControlPath=${this.controlPath}`,
    ];
    if (this.config.user) args.push('-l', this.config.user);
    if (this.config.port) args.push('-p', String(this.config.port));
    args.push(this.config.host, command);
    return args;
  }

  _realExec(command) {
    return new Promise((resolve, reject) => {
      execFile(
        'ssh',
        this._sshArgs(command),
        // 40s ceiling: comfortably longer than the 25s `timeout` wrapper the du-based
        // "top folder" scan runs remotely, while still bounding every other command.
        { timeout: 40000, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) return reject(new Error(stderr.trim() || err.message));
          resolve(stdout);
        }
      );
    });
  }

  async exec(command) {
    let lastErr;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const stdout = await this._execFn(command);
        this.connected = true;
        return stdout;
      } catch (err) {
        lastErr = err;
        this.connected = false;
        if (attempt < this.maxAttempts) await sleep(this.retryDelayMs * 2 ** (attempt - 1));
      }
    }
    throw lastErr;
  }

  disconnect() {
    execFile('ssh', ['-o', `ControlPath=${this.controlPath}`, '-O', 'exit', this.config.host], () => {});
    this.connected = false;
  }
}

module.exports = { SSHManager };
