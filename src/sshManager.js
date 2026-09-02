const { Client } = require('ssh2');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class SSHManager {
  constructor(serverConfig, { maxAttempts = 3, retryDelayMs = 5000, connectFn } = {}) {
    this.config = serverConfig;
    this.maxAttempts = maxAttempts;
    this.retryDelayMs = retryDelayMs;
    this.connected = false;
    this.client = null;
    this._connectFn = connectFn || (() => this._realConnect());
    this._connectingPromise = null;
  }

  _realConnect() {
    return new Promise((resolve, reject) => {
      const client = new Client();
      client.on('ready', () => resolve(client));
      client.on('error', reject);
      client.connect({
        host: this.config.host,
        username: this.config.user,
        port: this.config.port || 22,
      });
    });
  }

  // Resolves once connected. If a connection attempt is already in flight, joins it.
  // Each call after a failure starts a fresh retry cycle (natural backoff-forever via poll interval).
  async ensureConnected() {
    if (this.connected && this.client) return;
    if (!this._connectingPromise) {
      this._connectingPromise = this._connectWithRetry().finally(() => {
        this._connectingPromise = null;
      });
    }
    return this._connectingPromise;
  }

  async _connectWithRetry() {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const client = await this._connectFn();
        client.on('close', () => {
          this.connected = false;
          this.client = null;
        });
        client.on('error', () => {
          this.connected = false;
        });
        this.client = client;
        this.connected = true;
        return;
      } catch (err) {
        this.connected = false;
        if (attempt >= this.maxAttempts) throw err;
        await sleep(this.retryDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  exec(command) {
    return this.ensureConnected().then(
      () =>
        new Promise((resolve, reject) => {
          this.client.exec(command, (err, stream) => {
            if (err) return reject(err);
            let stdout = '';
            let stderr = '';
            stream.on('data', (d) => {
              stdout += d;
            });
            stream.stderr.on('data', (d) => {
              stderr += d;
            });
            stream.on('close', (code) => {
              if (code !== 0) return reject(new Error(`command exited ${code}: ${stderr.trim()}`));
              resolve(stdout);
            });
          });
        })
    );
  }

  disconnect() {
    if (this.client) this.client.end();
    this.connected = false;
  }
}

module.exports = { SSHManager };
