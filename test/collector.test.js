const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Collector } = require('../src/collector');
const { DEFAULTS } = require('../src/config');
const idleStore = require('../src/idleStore');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const tmpIdleFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'collector-')), 'idle-history.json');

// Fake SSH: the GPU query answers immediately, everything else (process queries) hangs
// until released, simulating a stuck `ps`/nvidia-smi on the remote.
function setup(idleHistoryFile = tmpIdleFile()) {
  const collector = new Collector({ ...DEFAULTS, idleHistoryFile, servers: [{ name: 's', host: 'h' }] });
  const pending = [];
  collector.ssh.set('s', {
    exec: (cmd) =>
      cmd === DEFAULTS.gpuQueryCommand
        ? Promise.resolve('0, GPU, 0, 1, 10, 30\n')
        : new Promise((resolve) => pending.push({ cmd, resolve })),
    disconnect: () => {},
  });
  const updates = [];
  collector.on('update', (s) => updates.push(s));
  return { collector, pending, updates, server: { name: 's', host: 'h' } };
}

test('a hung process query does not hold back GPU updates', async () => {
  const { collector, updates, server } = setup();
  await collector._pollGpu(server);
  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].gpu[0].utilization, 0);
});

test('process polls do not overlap while one is in flight; result rides the next update', async () => {
  const { collector, pending, updates, server } = setup();
  await collector._pollGpu(server);
  await collector._pollGpu(server);
  assert.strictEqual(pending.length, 2); // uuid + compute-apps from the first poll only

  const uuid = pending.find((p) => p.cmd === DEFAULTS.gpuUuidQueryCommand);
  const procs = pending.find((p) => p.cmd === DEFAULTS.gpuProcessesQueryCommand);
  uuid.resolve('0, GPU-abc\n');
  procs.resolve('GPU-abc, 42, /usr/bin/python, 100\n');
  await tick();
  pending.find((p) => p.cmd.startsWith('ps ')).resolve('42 f.manzoni python train.py\n');
  await tick();

  await collector._pollGpu(server);
  const last = updates[updates.length - 1];
  assert.strictEqual(last.gpuProcesses[0].owner, 'f.manzoni');
  assert.strictEqual(pending.length, 5); // in-flight cleared, so a new process poll started
});

test('loadConfig rejects a malformed userAvatars map', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { loadConfig } = require('../src/config');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 'config.json');
  for (const bad of [null, [], { 'f.manzoni': 42 }]) {
    fs.writeFileSync(file, JSON.stringify({ userAvatars: bad }));
    assert.throws(() => loadConfig(file), /userAvatars/);
  }
  fs.writeFileSync(file, JSON.stringify({ userAvatars: { 'f.manzoni': 'a.png' } }));
  assert.deepStrictEqual(loadConfig(file).userAvatars, { 'f.manzoni': 'a.png' });
});

test('GPU entries carry the idle summary', async () => {
  const { collector, updates, server } = setup();
  await collector._pollGpu(server);
  const gpu = updates[0].gpu[0];
  assert.strictEqual(typeof gpu.idleSince, 'number');
  assert.strictEqual(gpu.lastIdleMs, null);
  assert.strictEqual(gpu.idle30dMs, 0);
});

test('stop() saves idle history and a new collector resumes from it', async () => {
  const file = tmpIdleFile();
  const first = setup(file);
  await first.collector._pollGpu(first.server);
  first.collector.stop();

  const saved = idleStore.load(file);
  assert.strictEqual(typeof saved.s['0'].idleSince, 'number');

  const second = setup(file);
  await second.collector._pollGpu(second.server);
  assert.strictEqual(second.updates[0].gpu[0].idleSince, saved.s['0'].idleSince);
});

test('a failing save is logged and does not throw', (t) => {
  t.mock.method(console, 'warn', () => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-'));
  const blocker = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocker, '');
  const { collector } = setup(path.join(blocker, 'idle-history.json'));
  assert.doesNotThrow(() => collector.saveIdleHistory());
  assert.ok(console.warn.mock.calls.length > 0);
});

test('loadConfig rejects a non-string idleHistoryFile', () => {
  const { loadConfig } = require('../src/config');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ idleHistoryFile: 42 }));
  assert.throws(() => loadConfig(file), /idleHistoryFile/);
});
