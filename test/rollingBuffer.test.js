const test = require('node:test');
const assert = require('node:assert/strict');
const { RollingBuffer } = require('../src/rollingBuffer');

function gpuSnapshot(utils, mem = []) {
  return utils.map((u, id) => ({
    id,
    utilization: u,
    memory: mem[id] || { used: 0, total: 0 },
    temperature: 0,
  }));
}

test('RollingBuffer computes avg/max trends over the requested window', () => {
  const buf = new RollingBuffer({ historyMinutes: 5 });
  const now = 1_000_000;
  buf.push(gpuSnapshot([80, 100]), now - 30_000); // within 1m and 5m
  buf.push(gpuSnapshot([20, 40]), now - 120_000); // within 5m only
  const trends = buf.getTrends(now);
  assert.equal(trends.gpuAvgUtilization1m, 90); // avg(80,100)
  assert.equal(trends.gpuAvgUtilization5m, 60); // avg(80,100,20,40)
  assert.equal(trends.gpuMaxUtilization5m, 100);
});

test('RollingBuffer discards samples older than historyMinutes', () => {
  const buf = new RollingBuffer({ historyMinutes: 5 });
  const now = 1_000_000;
  buf.push(gpuSnapshot([99]), now - 10 * 60_000); // 10 min old, should be dropped
  buf.push(gpuSnapshot([10]), now - 1000);
  const trends = buf.getTrends(now);
  assert.equal(trends.gpuMaxUtilization5m, 10);
  assert.equal(buf.getHistoryByGpu()[0].length, 1);
});

test('RollingBuffer.getTrends returns nulls when no samples exist', () => {
  const buf = new RollingBuffer({ historyMinutes: 5 });
  const trends = buf.getTrends(Date.now());
  assert.deepEqual(trends, {
    gpuAvgUtilization1m: null,
    gpuAvgUtilization5m: null,
    gpuMaxUtilization5m: null,
  });
});

test('RollingBuffer.getHistoryByGpu returns a per-GPU utilization + memory% series for graphing', () => {
  const buf = new RollingBuffer({ historyMinutes: 5 });
  const now = 1_000_000;
  buf.push(gpuSnapshot([80, 40], [{ used: 50, total: 100 }, { used: 25, total: 100 }]), now);
  assert.deepEqual(buf.getHistoryByGpu(), {
    0: [{ timestamp: now, utilization: 80, memoryPercent: 50 }],
    1: [{ timestamp: now, utilization: 40, memoryPercent: 25 }],
  });
});

test('RollingBuffer.getHistoryByGpu handles zero-total memory without dividing by zero', () => {
  const buf = new RollingBuffer({ historyMinutes: 5 });
  const now = 1_000_000;
  buf.push(gpuSnapshot([10]), now);
  assert.deepEqual(buf.getHistoryByGpu()[0], [{ timestamp: now, utilization: 10, memoryPercent: 0 }]);
});
