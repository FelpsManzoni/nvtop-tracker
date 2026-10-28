const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Collector, SSH_DOWN_ERROR } = require('../src/collector');
const { DEFAULTS } = require('../src/config');
const idleStore = require('../src/idleStore');

const SERVER = 'GPU Server 1';
const tmpIdleFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'collector-')), 'idle-history.json');

// What nvtop-exporter publishes for one whole GPU, as Prometheus returns it. `ageMs` is how long
// ago the exporter's GPU poll last succeeded; `ssh` (1/0) adds the SSH probe's result.
function exporterSeries({ util = 0, ageMs = 1000, now = Date.now(), server = SERVER, ssh } = {}) {
  const S = (name, labels, value) => ({ labels: { __name__: name, server, ...labels }, value });
  return [
    ...(ssh === undefined ? [] : [S('nvtop_ssh_up', {}, ssh), S('nvtop_ssh_probe_duration_seconds', {}, 0.012)]),
    S('nvtop_gpu_info', { key: '0', label: 'GPU 0', gpu: '0', name: 'NVIDIA GPU', mig: 'false', gpu_instance_id: '', unified_memory: 'false' }, 1),
    S('nvtop_gpu_utilization_percent', { key: '0' }, util),
    S('nvtop_gpu_memory_used_mib', { key: '0' }, 1),
    S('nvtop_gpu_memory_total_mib', { key: '0' }, 10),
    S('nvtop_gpu_temperature_celsius', { key: '0' }, 30),
    S('nvtop_poll_last_success_timestamp_seconds', { poll: 'gpu' }, (now - ageMs) / 1000),
  ];
}

// Fake Prometheus: `ctl.series` is what the next instant query returns, `ctl.fail` makes it throw.
function setup({ idleHistoryFile = tmpIdleFile(), teamsWebhookUrl = '', servers = [{ name: SERVER }] } = {}) {
  const ctl = { series: exporterSeries(), fail: null, range: [], queries: 0, hold: null };
  const client = {
    query: async () => {
      ctl.queries += 1;
      if (ctl.hold) await ctl.hold;
      if (ctl.fail) throw ctl.fail;
      return { time: Date.now(), series: ctl.series };
    },
    queryRange: async () => ctl.range,
  };
  const collector = new Collector({ ...DEFAULTS, idleHistoryFile, teamsWebhookUrl, servers }, { client });
  const updates = [];
  collector.on('update', (s) => updates.push(s));
  const cards = [];
  if (collector.notifier) collector.notifier.send = async (card) => { cards.push(card); };
  return { collector, ctl, updates, cards };
}
const setupNotify = (idleHistoryFile, opts = {}) => setup({ idleHistoryFile, teamsWebhookUrl: 'https://example.invalid/hook', ...opts });

test('GPU entries read from Prometheus carry the idle summary', async () => {
  const { collector, updates } = setup();
  await collector.poll();
  const [state] = updates;
  assert.strictEqual(state.connected, true);
  const gpu = state.gpu[0];
  assert.deepEqual([gpu.key, gpu.utilization, gpu.memory], ['0', 0, { used: 1, total: 10 }]);
  assert.strictEqual(typeof gpu.idleSince, 'number');
  assert.strictEqual(gpu.lastIdleMs, null);
  assert.strictEqual(gpu.idle30dMs, 0);
});

test('stop() saves idle history and a new collector resumes from it', async () => {
  const file = tmpIdleFile();
  const first = setup({ idleHistoryFile: file });
  await first.collector.poll();
  first.collector.stop();

  const saved = idleStore.load(file);
  assert.strictEqual(typeof saved[SERVER]['0'].idleSince, 'number');

  const second = setup({ idleHistoryFile: file });
  await second.collector.poll();
  assert.strictEqual(second.updates[0].gpu[0].idleSince, saved[SERVER]['0'].idleSince);
});

test('a failing save is logged and does not throw', (t) => {
  t.mock.method(console, 'warn', () => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-'));
  const blocker = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocker, '');
  const { collector } = setup({ idleHistoryFile: path.join(blocker, 'idle-history.json') });
  const before = console.warn.mock.calls.length; // construction already warned about the unreadable path
  assert.doesNotThrow(() => collector.saveIdleHistory());
  assert.strictEqual(console.warn.mock.calls.length, before + 1);
  assert.match(console.warn.mock.calls.at(-1).arguments[0], /saving .* failed/);
});

test('start() registers the poll timer and a 60 s idle-history save timer; stop() clears every timer', (t) => {
  const file = tmpIdleFile();
  const { collector } = setup({ idleHistoryFile: file });
  let next = 0;
  const set = t.mock.method(globalThis, 'setInterval', () => ++next);
  const clear = t.mock.method(globalThis, 'clearInterval', () => {});
  collector.start();
  assert.ok(set.mock.calls.some((c) => c.arguments[1] === DEFAULTS.gpuPollIntervalMs), 'a poll timer is registered');
  const save = set.mock.calls.find((c) => c.arguments[1] === 60_000);
  assert.ok(save, 'a 60 s timer is registered');
  save.arguments[0]();
  assert.ok(fs.existsSync(file), 'the timer callback saves the file');
  collector.stop();
  const registered = set.mock.calls.map((c) => c.result).sort();
  const cleared = clear.mock.calls.map((c) => c.arguments[0]).sort();
  assert.deepStrictEqual(cleared, registered);
});

test('polls do not overlap while a query is in flight', async () => {
  const { collector, ctl } = setup();
  let release;
  ctl.hold = new Promise((r) => { release = r; });
  const first = collector.poll();
  await collector.poll();
  await collector.poll();
  release();
  await first;
  assert.strictEqual(ctl.queries, 1);
});

test('stale exporter data shows offline and never moves the idle timer or the graphs', async () => {
  const { collector, ctl, updates } = setup();
  await collector.poll();
  const before = updates[0];
  ctl.series = exporterSeries({ util: 80, ageMs: 30_000 });
  await collector.poll();
  const after = updates.at(-1);
  assert.deepEqual([after.connected, after.error], [false, 'sem dados novos do exporter há 30s']);
  assert.deepEqual(after.gpu, before.gpu, 'the last entries stay, with their idle state');
  assert.strictEqual(collector.buffers.get(SERVER).samples.length, 1);
});

test('a server Prometheus knows nothing about shows offline with an explanation', async () => {
  const { collector, ctl, updates } = setup();
  ctl.series = exporterSeries({ server: 'GPU Server 2' });
  await collector.poll();
  assert.deepEqual([updates[0].server, updates[0].connected, updates[0].error], [SERVER, false, 'nenhum dado do exporter no Prometheus']);
});

test('stale exporter data sends no Teams card; a failing SSH probe does, after 5 minutes', async () => {
  const { collector, ctl, cards, updates } = setupNotify();
  ctl.series = exporterSeries({ ageMs: 60_000, ssh: 1 });
  const T = Date.now();
  await collector.poll();
  await collector.tickNotifier(T + 10 * 60_000);
  assert.strictEqual(cards.length, 0, 'stale GPU data alone is not an outage');
  assert.deepEqual(updates.at(-1).ssh, { up: true, latencyMs: 12 });

  ctl.series = exporterSeries({ ssh: 0 });
  const D = Date.now();
  await collector.poll();
  await collector.tickNotifier(D + 60_000);
  assert.strictEqual(cards.length, 0);
  await collector.tickNotifier(D + 5 * 60_000 + 1000);
  assert.strictEqual(cards.length, 1);
  assert.match(cards[0].body[0].text, /GPU Server 1 inacessível/);
  assert.match(cards[0].body[2].text, new RegExp(SSH_DOWN_ERROR));

  ctl.series = exporterSeries({ ssh: 1 });
  await collector.poll();
  await collector.tickNotifier(D + 6 * 60_000);
  assert.match(cards[1].body[0].text, /GPU Server 1 voltou/);
});

test('without an SSH probe for a server, nothing is reported about its reachability', async () => {
  const { collector, ctl, updates } = setupNotify();
  ctl.series = exporterSeries({ ageMs: 60_000 });
  await collector.poll();
  assert.deepEqual(updates.at(-1).ssh, { up: null, latencyMs: null });
  assert.strictEqual(collector.notifier.toJSON()[SERVER], undefined);
});

test('a Prometheus outage sends no card, reports no server down and computes no idle from old data', async () => {
  const { collector, ctl, updates, cards } = setupNotify();
  ctl.series = exporterSeries({ ssh: 1 });
  const T = Date.now();
  await collector.poll(); // GPU 0 idle from now on
  ctl.fail = new Error('prometheus: request failed (network error)');
  await collector.poll();
  const last = updates.at(-1);
  assert.deepEqual([last.connected, last.error], [false, 'Prometheus inacessível: prometheus: request failed (network error)']);
  assert.strictEqual(collector.notifier.toJSON()[SERVER].downSince, null);
  // 13 h later the GPU would be due an idle card if its old entries still counted.
  await collector.tickNotifier(T + 13 * 3600_000);
  assert.strictEqual(cards.length, 0);
});

test('idleAlerts: false keeps a server out of the idle card and tells the browser', async () => {
  const servers = [{ name: SERVER }, { name: 'GPU Server 2', idleAlerts: false }];
  const { collector, ctl, cards, updates } = setupNotify(undefined, { servers });
  ctl.series = [...exporterSeries({ ssh: 1 }), ...exporterSeries({ server: 'GPU Server 2', ssh: 1 })];
  const T = Date.now();
  await collector.poll();
  await collector.tickNotifier(T + 13 * 3600_000);
  assert.strictEqual(cards.length, 1);
  const rows = cards[0].body.filter((b) => b.type === 'ColumnSet').slice(1).map((r) => r.columns[0].items[0].text);
  assert.deepEqual(rows, ['GPU Server 1']);
  assert.deepEqual(updates.filter((u) => u.server === 'GPU Server 2').map((u) => u.idleAlerts), [false]);
  assert.deepEqual(updates.filter((u) => u.server === SERVER).map((u) => u.idleAlerts), [true]);
});

test('notifier state is saved with the idle history and restored on restart', async () => {
  const file = tmpIdleFile();
  const first = setupNotify(file);
  first.ctl.series = exporterSeries({ ssh: 0 });
  const T = Date.now();
  await first.collector.poll();
  await first.collector.tickNotifier(T + 5 * 60_000 + 1000);
  assert.strictEqual(first.cards.length, 1);
  first.collector.stop();
  assert.ok(fs.existsSync(path.join(path.dirname(file), 'notifier-state.json')));
  const second = setupNotify(file);
  assert.strictEqual(typeof second.collector.notifier.toJSON()[SERVER].noticeAt, 'number');
  assert.strictEqual(second.collector.notifier.toJSON()[SERVER].noticeAt, first.collector.notifier.toJSON()[SERVER].noticeAt);
});

test('the webhook URL never reaches the SSE state', async () => {
  const { collector, updates } = setupNotify();
  await collector.poll();
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
  const { collector, ctl, cards } = setupNotify();
  let release;
  const held = new Promise((r) => { release = r; });
  collector.notifier.send = (card) => { cards.push(card); return held; };
  ctl.series = exporterSeries({ ssh: 0 });
  const T = Date.now();
  await collector.poll();
  const a = collector.tickNotifier(T + 301_000);
  const b = collector.tickNotifier(T + 302_000);
  release();
  await Promise.all([a, b]);
  assert.strictEqual(cards.length, 1);
});

test('seedHistory fills the graphs from Prometheus before the first live sample', async () => {
  const { collector, ctl, updates } = setup();
  const now = Date.now();
  const R = (name, labels, points) => ({ labels: { __name__: name, server: SERVER, ...labels }, points });
  ctl.range = [
    R('nvtop_gpu_info', { key: '0', label: 'GPU 0', gpu: '0', name: 'G', mig: 'false', gpu_instance_id: '', unified_memory: 'false' }, [[now - 4000, 1], [now - 2000, 1]]),
    R('nvtop_gpu_utilization_percent', { key: '0' }, [[now - 4000, 40], [now - 2000, 60]]),
  ];
  collector.seeded = collector.seedHistory(now);
  await collector.poll();
  assert.deepEqual(updates[0].historyByGpu['0'].map((p) => p.utilization), [40, 60, 0]);
});

test('a failed history load is logged and polling goes on', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { collector, updates } = setup();
  collector.client.queryRange = async () => { throw new Error('prometheus: HTTP 503'); };
  collector.seeded = collector.seedHistory();
  await collector.poll();
  assert.match(console.warn.mock.calls[0].arguments[0], /could not load the last 5 min/);
  assert.strictEqual(updates[0].connected, true);
});
