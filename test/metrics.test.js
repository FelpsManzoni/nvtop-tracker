const { test } = require('node:test');
const assert = require('node:assert');
const { renderMetrics, COMMAND_MAX } = require('../src/metrics');

const NOW = 1_800_000_000_000;
const LIMITS = { now: NOW, gpuStaleMs: 10_000, processesStaleMs: 60_000, diskStaleMs: 660_000 };
const never = { ok: null, at: null };

function snapshot(overrides = {}) {
  return {
    gpu: {
      ok: true,
      at: NOW - 1000,
      entries: [
        { id: 0, key: '0', label: 'GPU 0', name: 'NVIDIA GPU', mig: false, utilization: 92, memory: { used: 1685, total: 143771 }, temperature: 27 },
        { id: 7, key: '7-1', label: 'GPU 7 - 1', name: 'NVIDIA GPU', mig: true, gpuInstanceId: 3, utilization: null, memory: { used: 831, total: 33280 }, temperature: 47 },
      ],
    },
    processes: { ok: true, at: NOW - 1000, list: [{ gpuId: 7, gpuKey: '7-1', pid: 42, owner: 'jsilva', process: 'python', fullCommand: 'python "train.py"\n--x', memoryUsedMb: 740 }] },
    mig: { ok: false, at: NOW - 30_000 },
    disk: { ok: true, at: NOW - 1000, volumes: [{ filesystem: '/dev/data1', mountpoint: '/data/disk1', used: 10, total: 100, usagePercent: 10, topFolder: { path: '/data/disk1/x', sizeKb: 5 } }] },
    containers: { ok: true, at: NOW - 1000, list: [{ name: 'tracking-server', status: 'Up 2 hours (healthy)', created: 1761000000 }] },
    ...overrides,
  };
}

const lines = (text) => text.split('\n').filter((l) => l && !l.startsWith('#'));

test('every GPU entry gets an info series; unknown readings get no series at all', () => {
  const out = renderMetrics(snapshot(), LIMITS);
  assert.ok(out.includes('nvtop_gpu_info{key="0",label="GPU 0",gpu="0",name="NVIDIA GPU",mig="false",gpu_instance_id="",unified_memory="false"} 1'));
  assert.ok(out.includes('nvtop_gpu_info{key="7-1",label="GPU 7 - 1",gpu="7",name="NVIDIA GPU",mig="true",gpu_instance_id="3",unified_memory="false"} 1'));
  assert.ok(out.includes('nvtop_gpu_utilization_percent{key="0"} 92'));
  assert.ok(!out.includes('nvtop_gpu_utilization_percent{key="7-1"}'), 'unknown utilization is absent, not 0');
  assert.ok(out.includes('nvtop_gpu_memory_used_mib{key="7-1"} 831'));
});

test('label values are escaped and commands truncated', () => {
  const long = 'x'.repeat(COMMAND_MAX + 50);
  const base = snapshot();
  const out = renderMetrics(snapshot({ processes: { ...base.processes, list: [{ ...base.processes.list[0], fullCommand: `python "train.py"\n${long}` }] } }), LIMITS);
  const line = lines(out).find((l) => l.startsWith('nvtop_gpu_process_memory_mib'));
  assert.ok(line.includes('command="python \\"train.py\\"\\nxxx'));
  assert.ok(line.includes('user="jsilva"') && line.endsWith(' 740'));
  assert.strictEqual(line.match(/command="((?:[^"\\]|\\.)*)"/)[1].replace(/\\(.)/g, '$1').length, COMMAND_MAX);
});

test('results older than their stale limit are left out; poll status is always published', () => {
  const old = NOW - 11_000;
  const out = renderMetrics(snapshot({ gpu: { ...snapshot().gpu, ok: false, at: old } }), LIMITS);
  assert.ok(!out.includes('nvtop_gpu_info'));
  assert.ok(out.includes('nvtop_poll_success{poll="gpu"} 0'));
  assert.ok(out.includes(`nvtop_poll_last_success_timestamp_seconds{poll="gpu"} ${old / 1000}`));
  assert.ok(out.includes('nvtop_poll_success{poll="mig"} 0'));
  assert.ok(out.includes('nvtop_disk_top_folder_kib{mountpoint="/data/disk1",path="/data/disk1/x"} 5'));
  assert.ok(out.includes('nvtop_container_created_timestamp_seconds{name="tracking-server",status="Up 2 hours (healthy)"} 1761000000'));
});

test('polls never attempted publish nothing, and nothing at all before the first poll', () => {
  const out = renderMetrics({ gpu: { ...never, entries: [] }, processes: { ...never, list: [] }, mig: never, disk: { ...never, volumes: [] }, containers: { ...never, list: [] } }, LIMITS);
  assert.strictEqual(out, '');
});

test('duplicate series are dropped so Prometheus never rejects the scrape', () => {
  const base = snapshot();
  const out = renderMetrics(snapshot({ disk: { ...base.disk, volumes: [base.disk.volumes[0], base.disk.volumes[0]] } }), LIMITS);
  assert.strictEqual(lines(out).filter((l) => l.startsWith('nvtop_disk_size_kib')).length, 1);
  assert.strictEqual(out.match(/# TYPE nvtop_disk_size_kib gauge/g).length, 1);
});
