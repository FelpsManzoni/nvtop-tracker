const test = require('node:test');
const assert = require('node:assert/strict');
const { SSHManager } = require('../src/sshManager');

function fakeClient() {
  return { exec() {}, end() {}, on() { return this; } };
}

test('SSHManager retries connectFn up to maxAttempts then throws', async () => {
  let calls = 0;
  const mgr = new SSHManager(
    { host: 'h', user: 'u' },
    {
      maxAttempts: 3,
      retryDelayMs: 1,
      connectFn: () => {
        calls += 1;
        return Promise.reject(new Error('refused'));
      },
    }
  );
  await assert.rejects(() => mgr.ensureConnected(), /refused/);
  assert.equal(calls, 3);
  assert.equal(mgr.connected, false);
});

test('SSHManager succeeds once connectFn resolves, and reuses the connection', async () => {
  let calls = 0;
  const client = fakeClient();
  const mgr = new SSHManager(
    { host: 'h', user: 'u' },
    {
      maxAttempts: 3,
      retryDelayMs: 1,
      connectFn: () => {
        calls += 1;
        return Promise.resolve(client);
      },
    }
  );
  await mgr.ensureConnected();
  await mgr.ensureConnected();
  assert.equal(calls, 1);
  assert.equal(mgr.connected, true);
});

test('SSHManager retries fresh (new attempt count) on next ensureConnected after failure', async () => {
  let calls = 0;
  const client = fakeClient();
  const mgr = new SSHManager(
    { host: 'h', user: 'u' },
    {
      maxAttempts: 2,
      retryDelayMs: 1,
      connectFn: () => {
        calls += 1;
        // fail the first "cycle" (2 attempts), succeed on the second cycle's first attempt
        if (calls <= 2) return Promise.reject(new Error('down'));
        return Promise.resolve(client);
      },
    }
  );
  await assert.rejects(() => mgr.ensureConnected());
  await mgr.ensureConnected();
  assert.equal(mgr.connected, true);
});
