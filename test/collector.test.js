const { test } = require('node:test');
const assert = require('node:assert');
const { Collector } = require('../src/collector');
const { DEFAULTS } = require('../src/config');

const tick = () => new Promise((resolve) => setImmediate(resolve));

// Fake SSH: the GPU query answers immediately, everything else (process queries) hangs
// until released, simulating a stuck `ps`/nvidia-smi on the remote.
function setup() {
  const collector = new Collector({ ...DEFAULTS, servers: [{ name: 's', host: 'h' }] });
  const pending = [];
  collector.ssh.set('s', {
    exec: (cmd) =>
      cmd === DEFAULTS.gpuQueryCommand
        ? Promise.resolve('0, GPU, 0, 1, 10, 30\n')
        : new Promise((resolve) => pending.push({ cmd, resolve })),
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
