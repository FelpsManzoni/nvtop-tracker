const test = require('node:test');
const assert = require('node:assert/strict');
const { SSHManager } = require('../src/sshManager');

test('SSHManager.exec resolves with stdout on success and marks connected', async () => {
  const mgr = new SSHManager(
    { host: 'h200' },
    { maxAttempts: 3, retryDelayMs: 1, execFn: () => Promise.resolve('hello\n') }
  );
  const out = await mgr.exec('echo hello');
  assert.equal(out, 'hello\n');
  assert.equal(mgr.connected, true);
});

test('SSHManager.exec retries up to maxAttempts then throws, marking disconnected', async () => {
  let calls = 0;
  const mgr = new SSHManager(
    { host: 'h200' },
    {
      maxAttempts: 3,
      retryDelayMs: 1,
      execFn: () => {
        calls += 1;
        return Promise.reject(new Error('unreachable'));
      },
    }
  );
  await assert.rejects(() => mgr.exec('nvidia-smi'), /unreachable/);
  assert.equal(calls, 3);
  assert.equal(mgr.connected, false);
});

test('SSHManager.exec recovers on a later call after a prior failure', async () => {
  let calls = 0;
  const mgr = new SSHManager(
    { host: 'h200' },
    {
      maxAttempts: 2,
      retryDelayMs: 1,
      execFn: () => {
        calls += 1;
        if (calls <= 2) return Promise.reject(new Error('down'));
        return Promise.resolve('ok');
      },
    }
  );
  await assert.rejects(() => mgr.exec('nvidia-smi'));
  const out = await mgr.exec('nvidia-smi');
  assert.equal(out, 'ok');
  assert.equal(mgr.connected, true);
});
