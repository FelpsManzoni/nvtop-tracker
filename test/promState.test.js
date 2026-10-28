const { test } = require('node:test');
const assert = require('node:assert');
const { byServer, buildServerState, historySamples, labelFor } = require('../src/promState');

const NOW = 1_800_000_000_000;
const S = (name, labels, value) => ({ labels: { __name__: name, server: 'GPU Server 1', ...labels }, value });
const info = (key, extra = {}) => S('nvtop_gpu_info', {
  key, label: labelFor(key), gpu: key.split('-')[0], name: 'NVIDIA GPU', mig: key.includes('-') ? 'true' : 'false',
  gpu_instance_id: key.includes('-') ? '3' : '', unified_memory: 'false', ...extra,
}, 1);
const fresh = S('nvtop_poll_last_success_timestamp_seconds', { poll: 'gpu' }, (NOW - 2000) / 1000);
const opts = { now: NOW, staleAfterMs: 10_000, diskAlertThreshold: 85, userAvatars: { 'jsilva': 'a.png' } };

test('entries come back in nvidia-smi order with partitions after their GPU, unknown readings as null', () => {
  const series = [
    fresh,
    info('7-2'), info('7-1'), info('0'), info('10'),
    S('nvtop_gpu_utilization_percent', { key: '0' }, 92),
    S('nvtop_gpu_memory_used_mib', { key: '0' }, 1685),
    S('nvtop_gpu_memory_total_mib', { key: '0' }, 143771),
    S('nvtop_gpu_temperature_celsius', { key: '0' }, 27),
    S('nvtop_gpu_memory_used_mib', { key: '7-1' }, 831),
  ];
  const s = buildServerState(series, opts);
  assert.strictEqual(s.fresh, true);
  assert.deepEqual(s.gpu.map((e) => e.key), ['0', '7-1', '7-2', '10']);
  assert.deepEqual(s.gpu[0], {
    id: 0, key: '0', label: 'GPU 0', name: 'NVIDIA GPU', mig: false, unifiedMemory: false,
    utilization: 92, memory: { used: 1685, total: 143771 }, temperature: 27,
  });
  assert.deepEqual([s.gpu[1].mig, s.gpu[1].gpuInstanceId, s.gpu[1].utilization, s.gpu[1].memory, s.gpu[1].temperature], [true, 3, null, { used: 831, total: null }, null]);
});

test('processes carry their entry label, owner and avatar; containers newest first; disks with the alert flag', () => {
  const series = [
    fresh, info('7-1'),
    S('nvtop_gpu_process_memory_mib', { key: '7-1', gpu: '7', pid: '42', user: 'jsilva', process: 'python', command: 'python train.py' }, 740),
    S('nvtop_gpu_process_memory_mib', { key: '0', gpu: '0', pid: '7', user: '', process: 'x', command: '/x' }, 10),
    S('nvtop_container_created_timestamp_seconds', { name: 'old', status: 'Up 3 days' }, 100),
    S('nvtop_container_created_timestamp_seconds', { name: 'new', status: 'Up 2 hours (healthy)' }, 200),
    S('nvtop_disk_size_kib', { mountpoint: '/data/b', filesystem: '/dev/b' }, 100),
    S('nvtop_disk_used_kib', { mountpoint: '/data/b' }, 90),
    S('nvtop_disk_usage_percent', { mountpoint: '/data/b' }, 90),
    S('nvtop_disk_top_folder_kib', { mountpoint: '/data/b', path: '/data/b/big' }, 80),
    S('nvtop_disk_size_kib', { mountpoint: '/data/a', filesystem: '/dev/a' }, 100),
    S('nvtop_disk_used_kib', { mountpoint: '/data/a' }, 10),
    S('nvtop_disk_usage_percent', { mountpoint: '/data/a' }, 10),
    S('nvtop_disk_size_kib', { mountpoint: '/data/partial', filesystem: '/dev/c' }, 100),
  ];
  const s = buildServerState(series, opts);
  assert.deepEqual(s.gpuProcesses, [
    { gpuId: 0, gpuKey: '0', gpuLabel: 'GPU 0', pid: 7, process: 'x', fullCommand: '/x', memoryUsedMb: 10 },
    { gpuId: 7, gpuKey: '7-1', gpuLabel: 'GPU 7 - 1', pid: 42, process: 'python', fullCommand: 'python train.py', memoryUsedMb: 740, owner: 'jsilva', avatarUrl: '/avatars/jsilva' },
  ]);
  assert.deepEqual(s.docker, { containers: [{ name: 'new', status: 'Up 2 hours (healthy)' }, { name: 'old', status: 'Up 3 days' }], images: [] });
  assert.deepEqual(s.disk, [
    { filesystem: '/dev/a', mountpoint: '/data/a', used: 10, total: 100, usagePercent: 10, topFolder: null, alert: false },
    { filesystem: '/dev/b', mountpoint: '/data/b', used: 90, total: 100, usagePercent: 90, topFolder: { path: '/data/b/big', sizeKb: 80 }, alert: true },
  ]);
});

test('GPU data is stale once the exporter stopped succeeding, and missing when it never reported', () => {
  const at = (ageMs) => [S('nvtop_poll_last_success_timestamp_seconds', { poll: 'gpu' }, (NOW - ageMs) / 1000)];
  assert.strictEqual(buildServerState(at(10_000), opts).fresh, true);
  assert.deepEqual(buildServerState(at(12_000), opts), { ...buildServerState(at(12_000), opts), fresh: false, error: 'sem dados novos do exporter há 12s' });
  assert.strictEqual(buildServerState(at(125_000), opts).error, 'sem dados novos do exporter há 2min');
  assert.deepEqual([buildServerState([], opts).fresh, buildServerState([], opts).error], [false, 'nenhum dado do exporter no Prometheus']);
  const other = [S('nvtop_poll_last_success_timestamp_seconds', { poll: 'disk' }, NOW / 1000)];
  assert.strictEqual(buildServerState(other, opts).fresh, false);
});

test('byServer groups series by their server label and skips unlabeled ones', () => {
  const jetson = { labels: { __name__: 'nvtop_gpu_info', server: 'GPU Server 2' }, value: 1 };
  const grouped = byServer([fresh, jetson, { labels: { __name__: 'up' }, value: 1 }]);
  assert.deepEqual([...grouped.keys()], ['GPU Server 1', 'GPU Server 2']);
  assert.deepEqual(grouped.get('GPU Server 2'), [jetson]);
});

test('historySamples rebuilds RollingBuffer samples per server in time order', () => {
  const range = (name, labels, points) => ({ labels: { __name__: name, server: 'GPU Server 2', ...labels }, points });
  const infoLabels = { key: '0', label: 'GPU 0', gpu: '0', name: 'NVIDIA Jetson', mig: 'false', gpu_instance_id: '', unified_memory: 'true' };
  const samples = historySamples([
    range('nvtop_gpu_utilization_percent', { key: '0' }, [[2000, 5], [1000, 0]]),
    range('nvtop_gpu_info', infoLabels, [[2000, 1], [1000, 1]]),
    range('nvtop_gpu_memory_used_mib', { key: '0' }, [[1000, 100]]),
    range('nvtop_gpu_memory_total_mib', { key: '0' }, [[1000, 1000], [2000, 1000]]),
    range('nvtop_gpu_utilization_percent', { key: '9' }, [[1000, 50]]), // no info series: ignored
  ]).get('GPU Server 2');
  assert.deepEqual(samples.map((s) => [s.timestamp, s.gpus.map((g) => [g.key, g.utilization, g.memory.used, g.memory.total, g.unifiedMemory])]), [
    [1000, [['0', 0, 100, 1000, true]]],
    [2000, [['0', 5, null, 1000, true]]],
  ]);
});
