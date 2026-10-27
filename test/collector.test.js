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

// Fake SSH for a server with one whole GPU and one MIG GPU (GPU 7 reports [N/A]).
function setupMig({ dmon, migHang } = {}) {
  const ctl = { gpu7: '[N/A]' };
  const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
  const collector = new Collector({ ...DEFAULTS, idleHistoryFile: tmpIdleFile(), servers: [{ name: 's', host: 'h' }] });
  const executed = [];
  const migCmd = DEFAULTS.migQueryCommand.replace('{gpu}', '7');
  collector.ssh.set('s', {
    exec: (cmd) => {
      executed.push(cmd);
      if (cmd === DEFAULTS.gpuQueryCommand) {
        return Promise.resolve(`0, NVIDIA H200 NVL, 92, 1685, 143771, 27\n7, NVIDIA H200 NVL, ${ctl.gpu7}, 33435, 143771, 47\n`);
      }
      if (cmd === DEFAULTS.gpuUuidQueryCommand) return Promise.resolve('0, GPU-a\n7, GPU-b\n');
      if (cmd === DEFAULTS.gpuProcessesQueryCommand) return Promise.resolve('GPU-b, 555, /usr/bin/python, 100\n');
      if (cmd === migCmd) return migHang ? new Promise(() => {}) : Promise.resolve(fx('mig-gpu.xml'));
      if (cmd === DEFAULTS.dcgmDiscoveryCommand) return Promise.resolve(fx('dcgm-discovery.txt'));
      if (cmd.startsWith('timeout 10 dcgmi dmon')) return dmon ? dmon() : Promise.resolve(fx('dcgm-dmon.txt'));
      if (cmd.startsWith('ps ')) return Promise.resolve('3978767 alice python train.py\n');
      return Promise.resolve('');
    },
    disconnect: () => {},
  });
  const updates = [];
  collector.on('update', (s) => updates.push(s));
  return { collector, ctl, updates, executed, server: { name: 's', host: 'h' } };
}

test('a server with a MIG GPU shows its partitions after the MIG poll lands', async () => {
  const { collector, updates, server } = setupMig();
  await collector._pollGpu(server);
  assert.deepEqual(updates[0].gpu.map((g) => g.key), ['0', '7']);
  await tick(); await tick(); await tick();
  await collector._pollGpu(server);
  const last = updates.at(-1);
  assert.deepEqual(last.gpu.map((g) => g.key), ['0', '7-1', '7-2', '7-3']);
  assert.equal(last.gpu[1].utilization, 84.5);
  assert.equal(last.connected, true);
});

test('a DCGM failure leaves partitions with unknown utilization and other GPUs untouched', async () => {
  const { collector, updates, server } = setupMig({ dmon: () => Promise.reject(new Error('connection refused')) });
  await collector._pollGpu(server);
  await tick(); await tick(); await tick();
  await collector._pollGpu(server);
  const last = updates.at(-1);
  assert.deepEqual(last.gpu.map((g) => [g.key, g.utilization]), [['0', 92], ['7-1', null], ['7-2', null], ['7-3', null]]);
  assert.equal(last.connected, true);
});

test('a server without [N/A] GPUs runs no MIG commands', async () => {
  const collector = new Collector({ ...DEFAULTS, idleHistoryFile: tmpIdleFile(), servers: [{ name: 's', host: 'h' }] });
  const executed = [];
  collector.ssh.set('s', {
    exec: (cmd) => { executed.push(cmd); return Promise.resolve(cmd === DEFAULTS.gpuQueryCommand ? '0, GPU, 0, 1, 10, 30\n' : ''); },
    disconnect: () => {},
  });
  await collector._pollGpu({ name: 's', host: 'h' });
  await tick(); await tick();
  assert.ok(!executed.some((c) => c.includes('nvidia-smi -q -x') || c.includes('dcgmi')));
});

test('MIG polls do not overlap', async () => {
  const { collector, executed, server } = setupMig({ migHang: true });
  await collector._pollGpu(server);
  await collector._pollGpu(server);
  assert.equal(executed.filter((c) => c === DEFAULTS.migQueryCommand.replace('{gpu}', '7')).length, 1);
});

test('cached MIG state is forgotten when a GPU leaves MIG mode', async () => {
  const { collector, ctl, updates, server } = setupMig();
  await collector._pollGpu(server);
  for (let i = 0; i < 4; i++) await tick();
  await collector._pollGpu(server);
  let last = updates.at(-1);
  assert.deepEqual(last.gpu.map((g) => g.key), ['0', '7-1', '7-2', '7-3']);
  assert.ok(last.gpuProcesses.some((r) => r.gpuKey === '7-1'));

  ctl.gpu7 = '40';
  await collector._pollGpu(server);
  last = updates.at(-1);
  assert.deepEqual(last.gpu.map((g) => [g.key, g.utilization]), [['0', 92], ['7', 40]]);
  const rows7 = last.gpuProcesses.filter((r) => r.gpuId === 7);
  assert.deepEqual(rows7.map((r) => [r.gpuKey, r.pid]), [['7', 555]]);
  assert.ok(!collector.mig.get('s').util.size);
});

test('a MIG poll that started before a GPU left and re-entered [N/A] does not publish its stale layout', async () => {
  const { collector, ctl, updates, server } = setupMig();
  const migCmd = DEFAULTS.migQueryCommand.replace('{gpu}', '7');
  const inner = collector.ssh.get('s').exec;
  let release;
  collector.ssh.get('s').exec = (cmd) => (cmd === migCmd ? new Promise((r) => (release = r)) : inner(cmd));
  await collector._pollGpu(server); // poll A starts and hangs
  ctl.gpu7 = '40';
  await collector._pollGpu(server); // GPU 7 numeric: evicted
  ctl.gpu7 = '[N/A]';
  await collector._pollGpu(server);
  release(fs.readFileSync(path.join(__dirname, 'fixtures', 'mig-gpu.xml'), 'utf8'));
  for (let i = 0; i < 6; i++) await tick();
  await collector._pollGpu(server);
  const last = updates.at(-1);
  assert.deepEqual(last.gpu.filter((g) => g.id === 7).map((g) => [g.key, g.utilization]), [['7', null]]);
  assert.ok(!last.gpu.some((g) => g.key.startsWith('7-')));
});

test('loadConfig rejects a bad teamsWebhookUrl', () => {
  const { loadConfig } = require('../src/config');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 'config.json');
  for (const bad of [42, 'http://x', 'https://x/invoke?api-version\\=1']) {
    fs.writeFileSync(file, JSON.stringify({ teamsWebhookUrl: bad }));
    assert.throws(() => loadConfig(file), /teamsWebhookUrl/);
  }
  fs.writeFileSync(file, JSON.stringify({ teamsWebhookUrl: '' }));
  assert.equal(loadConfig(file).teamsWebhookUrl, '');
  assert.equal(loadConfig(path.join(os.tmpdir(), 'nonexistent-cfg.json')).teamsWebhookUrl, '');
});

// Collector with a webhook configured and a controllable GPU/disk SSH; cards are recorded.
function setupNotify(idleHistoryFile = tmpIdleFile()) {
  const collector = new Collector({
    ...DEFAULTS,
    idleHistoryFile,
    teamsWebhookUrl: 'https://example.invalid/hook',
    servers: [{ name: 's', host: 'h' }],
  });
  const ctl = { gpuFails: true };
  collector.ssh.set('s', {
    exec: (cmd) => {
      if (cmd === DEFAULTS.gpuQueryCommand) return ctl.gpuFails ? Promise.reject(new Error('ssh timeout')) : Promise.resolve('0, GPU, 0, 1, 10, 30\n');
      if (cmd === DEFAULTS.diskQueryCommand) return Promise.resolve('');
      return Promise.reject(new Error('unused'));
    },
    disconnect: () => {},
  });
  const cards = [];
  collector.notifier.send = async (card) => { cards.push(card); };
  return { collector, ctl, cards, server: { name: 's', host: 'h' } };
}

test('a GPU poll failure is observed as down and a disk success does not clear it', async () => {
  const { collector, server } = setupNotify();
  await collector._pollGpu(server);
  await collector._pollDisk(server);
  assert.strictEqual(typeof collector.notifier.toJSON().s.downSince, 'number');
});

test('tickNotifier sends a down card after 5 minutes of GPU poll failures', async () => {
  const { collector, cards, server } = setupNotify();
  const T = Date.now();
  await collector._pollGpu(server);
  await collector.tickNotifier(T + 60_000);
  assert.strictEqual(cards.length, 0);
  await collector.tickNotifier(T + 5 * 60_000 + 1000);
  assert.strictEqual(cards.length, 1);
  assert.match(cards[0].body[0].text, /inacessível/);
});

test('notifier state is saved with the idle history and restored on restart', async () => {
  const file = tmpIdleFile();
  const first = setupNotify(file);
  const T = Date.now();
  await first.collector._pollGpu(first.server);
  await first.collector.tickNotifier(T + 5 * 60_000 + 1000);
  assert.strictEqual(first.cards.length, 1);
  first.collector.stop();
  assert.ok(fs.existsSync(path.join(path.dirname(file), 'notifier-state.json')));
  const second = setupNotify(file);
  assert.strictEqual(second.collector.notifier.toJSON().s.noticeAt, first.collector.notifier.toJSON().s.noticeAt);
  assert.strictEqual(typeof second.collector.notifier.toJSON().s.noticeAt, 'number');
});

test('the webhook URL never reaches the SSE state', async () => {
  const { collector, server } = setupNotify();
  const updates = [];
  collector.on('update', (s) => updates.push(s));
  await collector._pollGpu(server);
  assert.ok(!JSON.stringify([updates, collector.getSnapshot()]).includes('example.invalid'));
});

test('no notifier and no extra timer when teamsWebhookUrl is empty', (t) => {
  const { collector } = setup();
  assert.strictEqual(collector.notifier, null);
  const set = t.mock.method(globalThis, 'setInterval', () => 1);
  t.mock.method(globalThis, 'clearInterval', () => {});
  collector.start();
  assert.strictEqual(set.mock.calls.filter((c) => c.arguments[1] === 60_000).length, 1);
  assert.doesNotThrow(() => collector.stop());
  assert.doesNotThrow(() => collector.tickNotifier());
  assert.ok(!fs.existsSync(collector.notifierStateFile));
});

test('start() registers a second 60 s timer for the notifier when a URL is set', (t) => {
  const { collector } = setupNotify();
  const set = t.mock.method(globalThis, 'setInterval', () => 1);
  t.mock.method(globalThis, 'clearInterval', () => {});
  collector.start();
  assert.strictEqual(set.mock.calls.filter((c) => c.arguments[1] === 60_000).length, 2);
  collector.stop();
});

test('overlapping notifier ticks do not double-send', async () => {
  const { collector, cards, server } = setupNotify();
  let release;
  const held = new Promise((r) => { release = r; });
  collector.notifier.send = (card) => { cards.push(card); return held; };
  const T = Date.now();
  await collector._pollGpu(server);
  const a = collector.tickNotifier(T + 301_000);
  const b = collector.tickNotifier(T + 302_000);
  release();
  await Promise.all([a, b]);
  assert.strictEqual(cards.length, 1);
});
