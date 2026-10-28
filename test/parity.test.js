const { test } = require('node:test');
const assert = require('node:assert');
const { compareServer, persistent } = require('../scripts/parity/compare');

const gpu = (key, extra = {}) => ({
  key, label: `GPU ${key}`, mig: false, utilization: 50, memory: { used: 1000, total: 100000 }, temperature: 40,
  unifiedMemory: false, lastIdleMs: null, idle30dMs: 0, ...extra,
});
function side({ gpus = [gpu('0')], cards, procs = [], containers = ['a'], disk = [{ mountpoint: '/data/x', usagePercent: 50, topFolder: null }], connected = true } = {}) {
  return {
    state: { connected, gpu: gpus, gpuProcesses: procs, docker: { containers: containers.map((name) => ({ name })) }, disk },
    dom: { cards: cards || gpus.map((g) => ({ label: g.label, pill: 'in use' })), processRows: procs.length, dockerRows: containers.length, diskRows: disk.length },
  };
}
const items = (ms) => ms.map((m) => [m.item, m.key, m.expected]);

test('identical captures and differences within tolerance produce no mismatch', () => {
  const b = side({ gpus: [gpu('0', { utilization: 58, memory: { used: 2900, total: 100000 }, temperature: 43 })] });
  assert.deepEqual(compareServer('S', side(), b), []);
});

test('utilization must keep its idle/busy class and stay within 10 points', () => {
  assert.deepEqual(items(compareServer('S', side({ gpus: [gpu('0', { utilization: 0 })] }), side({ gpus: [gpu('0', { utilization: 5 })] }))), [['utilization', 'GPU 0', false]]);
  assert.deepEqual(items(compareServer('S', side(), side({ gpus: [gpu('0', { utilization: 70 })] }))), [['utilization', 'GPU 0', false]]);
  assert.deepEqual(items(compareServer('S', side(), side({ gpus: [gpu('0', { utilization: null })] }))), [['utilization', 'GPU 0', false]]);
});

test('a Jetson showing a GPU only on the new board is expected; other entry differences are not', () => {
  const jetson = side({ gpus: [gpu('0', { unifiedMemory: true })] });
  assert.deepEqual(items(compareServer('GPU Server 2', side({ gpus: [] }), jetson)), [['GPU entries', '', true]]);
  assert.deepEqual(items(compareServer('S', side(), side({ gpus: [gpu('0'), gpu('1')] }))).slice(0, 1), [['GPU entries', '', false]]);
});

test('MIG partitions are compared one by one, pill and idle time included', () => {
  const parts = (pill7) => side({
    gpus: [gpu('7-1', { mig: true, utilization: null }), gpu('7-2', { mig: true, utilization: 0 })],
    cards: [{ label: 'GPU 7-1', pill: 'MIG' }, { label: 'GPU 7-2', pill: 'idle', idleText: pill7 }],
  });
  assert.deepEqual(compareServer('S', parts('01:00:00'), parts('01:00:08')), []);
  assert.deepEqual(items(compareServer('S', parts('01:00:00'), parts('01:00:30'))), [['idle time', 'GPU 7-2', false]]);
  assert.deepEqual(compareServer('S', parts('01:00:00'), parts('01:00:30'), { skipIdleTime: true }), []);
});

test('owners, processes, commands, containers and disks', () => {
  const p = (pid, owner, fullCommand = 'python x.py') => ({ gpuKey: '0', pid, owner, fullCommand });
  const a = side({ procs: [p(1, 'ana'), p(2, 'bia', `python ${'y'.repeat(600)}`)], containers: ['a', 'b'] });
  const b = side({
    procs: [p(1, 'ana'), p(2, 'bia', `python ${'y'.repeat(493)}`), p(3, 'caio')],
    containers: ['a'],
    disk: [{ mountpoint: '/data/x', usagePercent: 52, topFolder: { path: '/data/x/big', sizeKb: 1 } }],
  });
  assert.deepEqual(items(compareServer('S', a, b)), [
    ['owners', '0', false],
    ['GPU process', '0/3/caio', false],
    ['container', 'b', false],
    ['disk usage', '/data/x', false],
    ['biggest folder', '/data/x', true],
    ['rendered rows', 'processRows', false],
    ['rendered rows', 'dockerRows', false],
  ]);
});

test('long commands are compared up to the truncation on both sides', () => {
  const long = { gpuKey: '0', pid: 1, owner: 'ana', fullCommand: `python ${'z'.repeat(700)}` };
  assert.deepEqual(compareServer('S', side({ procs: [long] }), side({ procs: [long] })), []);
  const other = { ...long, fullCommand: `python ${'w'.repeat(700)}` };
  assert.deepEqual(items(compareServer('S', side({ procs: [long] }), side({ procs: [other] }))), [['process command', '0/1/ana', false]]);
});

test('a server offline on one side only is one mismatch', () => {
  assert.deepEqual(items(compareServer('S', side(), side({ connected: false }))), [['online', '', false]]);
  assert.deepEqual(compareServer('S', side({ connected: false }), side({ connected: false })), []);
});

test('only unexpected mismatches present in two consecutive rounds persist', () => {
  const m = (key, expected = false) => ({ server: 'S', item: 'utilization', key, expected });
  assert.deepEqual(persistent([[m('GPU 0'), m('GPU 1', true)], [m('GPU 1', true)], [m('GPU 2')], [m('GPU 2'), m('GPU 0')]]), [m('GPU 2')]);
});

test('container and disk mismatches must outlast a 5-minute poll before they count', () => {
  const c = { server: 'S', item: 'container', key: 'nvtop-exporter-1', expected: false };
  const rows = { server: 'S', item: 'rendered rows', key: 'dockerRows', expected: false };
  const procRows = { server: 'S', item: 'rendered rows', key: 'processRows', expected: false };
  const rounds = (n, ...ms) => Array.from({ length: n }, () => ms);
  assert.deepEqual(persistent(rounds(12, c, rows), { intervalMs: 30_000 }), []); // 5.5 min: one board still lagging
  assert.deepEqual(persistent(rounds(13, c, rows), { intervalMs: 30_000 }), [c, rows]);
  assert.deepEqual(persistent(rounds(2, procRows), { intervalMs: 30_000 }), [procRows]);
});
