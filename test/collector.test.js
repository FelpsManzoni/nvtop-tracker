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
  const before = console.warn.mock.calls.length; // construction already warned about the unreadable path
  assert.doesNotThrow(() => collector.saveIdleHistory());
  assert.strictEqual(console.warn.mock.calls.length, before + 1);
  assert.match(console.warn.mock.calls.at(-1).arguments[0], /saving .* failed/);
});

test('start() registers a 60 s idle-history save timer and stop() clears every timer', (t) => {
  const file = tmpIdleFile();
  const { collector } = setup(file);
  let next = 0;
  const set = t.mock.method(globalThis, 'setInterval', () => ++next);
  const clear = t.mock.method(globalThis, 'clearInterval', () => {});
  collector.start();
  const save = set.mock.calls.find((c) => c.arguments[1] === 60_000);
  assert.ok(save, 'a 60 s timer is registered');
  save.arguments[0]();
  assert.ok(fs.existsSync(file), 'the timer callback saves the file');
  collector.stop();
  const registered = set.mock.calls.map((c) => c.result).sort();
  const cleared = clear.mock.calls.map((c) => c.arguments[0]).sort();
  assert.deepStrictEqual(cleared, registered);
});

test('loadConfig rejects a non-string idleHistoryFile', () => {
  const { loadConfig } = require('../src/config');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ idleHistoryFile: 42 }));
  assert.throws(() => loadConfig(file), /idleHistoryFile/);
});
