const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildGpuEntries, buildGpuProcesses } = require('../src/mig');
const { parseMigXml } = require('../src/parsers');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const gpu0 = { id: 0, key: '0', label: 'GPU 0', name: 'NVIDIA GPU', utilization: 92, memory: { used: 1685, total: 143771 }, temperature: 27 };
const gpu7 = { id: 7, key: '7', label: 'GPU 7', name: 'NVIDIA GPU', utilization: null, memory: { used: 33435, total: 143771 }, temperature: 47 };
const mig7 = parseMigXml(fx('mig-gpu.xml'));
const fullUtil = (at) => new Map([['7/3', { value: 0.845, at }], ['7/5', { value: 0.871, at }], ['7/6', { value: 0.931, at }]]);

test('a MIG GPU is replaced by one entry per partition with DCGM utilization', () => {
  const e = buildGpuEntries([gpu0, gpu7], new Map([[7, mig7]]), fullUtil(1000), 2000, 6000);
  assert.deepEqual(e.map((x) => [x.key, x.label, x.utilization, x.memory.used, x.temperature, x.mig]), [
    ['0', 'GPU 0', 92, 1685, 27, false],
    ['7-1', 'GPU 7 - 1', 84.5, 831, 47, true],
    ['7-2', 'GPU 7 - 2', 87.1, 13433, 47, true],
    ['7-3', 'GPU 7 - 3', 93.1, 19171, 47, true],
  ]);
});

test('a DCGM reading older than staleMs is unknown', () => {
  const e = buildGpuEntries([gpu7], new Map([[7, mig7]]), fullUtil(1000), 8000, 6000);
  assert.deepEqual(e.map((x) => [x.key, x.utilization]), [['7-1', null], ['7-2', null], ['7-3', null]]);
});

test('a partition with no DCGM entity has unknown utilization', () => {
  const util = fullUtil(1000);
  util.delete('7/5');
  const e = buildGpuEntries([gpu7], new Map([[7, mig7]]), util, 2000, 6000);
  assert.deepEqual(e.map((x) => [x.key, x.utilization]), [['7-1', 84.5], ['7-2', null], ['7-3', 93.1]]);
});

test('a GPU whose XML query failed stays a single n/a entry', () => {
  const e = buildGpuEntries([gpu7], new Map(), new Map(), 2000, 6000);
  assert.deepEqual(e.map((x) => [x.key, x.utilization, x.mig]), [['7', null, false]]);
});

test('a non-MIG GPU reporting [N/A] stays a single entry', () => {
  const off = parseMigXml(fx('mig-disabled.xml'));
  const e = buildGpuEntries([gpu7], new Map([[7, off]]), new Map(), 2000, 6000);
  assert.deepEqual(e.map((x) => [x.key, x.utilization, x.mig]), [['7', null, false]]);
});

test('buildGpuProcesses relabels MIG processes per partition and drops unmatched ones', () => {
  const base = [{ gpuId: 0, gpuKey: '0', gpuLabel: 'GPU 0', pid: 1 }, { gpuId: 7, gpuKey: '7', gpuLabel: 'GPU 7', pid: 3978767 }];
  const mig = { ...mig7, processes: [...mig7.processes, { gpuInstanceId: 9, pid: 42, process: 'x', fullCommand: 'x', memoryUsedMb: 1 }] };
  const rows = buildGpuProcesses(base, new Map([[7, mig]]));
  assert.deepEqual(rows.map((r) => [r.gpuKey, r.gpuLabel, r.pid]), [
    ['0', 'GPU 0', 1], ['7-1', 'GPU 7 - 1', 3978767], ['7-2', 'GPU 7 - 2', 120122], ['7-3', 'GPU 7 - 3', 31391],
  ]);
});

// Layout read from DCGM (the XML hid the partitions): no memory or processes of its own.
const dcgm7 = {
  migEnabled: true,
  source: 'dcgm',
  devices: [3, 5].map((gpuInstanceId, migIndex) => ({ migIndex, gpuInstanceId, memory: { used: null, total: null } })),
  processes: [],
};

test('a DCGM-read layout takes partition memory from the DCGM reading while it is fresh', () => {
  const util = new Map([['7/3', { value: 0.5, at: 1000, memory: { used: 831, total: 33280 } }], ['7/5', { value: null, at: 1000 }]]);
  assert.deepEqual(buildGpuEntries([gpu7], new Map([[7, dcgm7]]), util, 2000, 6000).map((x) => [x.key, x.utilization, x.memory]), [
    ['7-1', 50, { used: 831, total: 33280 }],
    ['7-2', null, { used: null, total: null }],
  ]);
  assert.deepEqual(buildGpuEntries([gpu7], new Map([[7, dcgm7]]), util, 8000, 6000).map((x) => x.memory.used), [null, null]);
});

test('buildGpuProcesses keeps whole-GPU rows when the layout came from DCGM', () => {
  const base = [{ gpuId: 7, gpuKey: '7', gpuLabel: 'GPU 7', pid: 555 }];
  assert.deepEqual(buildGpuProcesses(base, new Map([[7, dcgm7]])).map((r) => [r.gpuKey, r.pid]), [['7', 555]]);
});
