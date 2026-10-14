const { test } = require('node:test');
const assert = require('node:assert');
const { IdleTracker } = require('../src/idleTracker');

const gpu = (id, utilization) => ({ id, utilization });

test('idle GPU gets idleSince on first idle sample and keeps it while idle', () => {
  const t = new IdleTracker();
  t.update([gpu(0, 0)], 1000);
  t.update([gpu(0, 0)], 5000);
  assert.strictEqual(t.idleSince(0), 1000);
});

test('utilization >= 1% clears idleSince; going idle again restarts it', () => {
  const t = new IdleTracker();
  t.update([gpu(0, 0)], 1000);
  t.update([gpu(0, 1)], 2000);
  assert.strictEqual(t.idleSince(0), null);
  t.update([gpu(0, 0)], 3000);
  assert.strictEqual(t.idleSince(0), 3000);
});

test('GPUs are tracked independently and unknown GPUs are null', () => {
  const t = new IdleTracker();
  t.update([gpu(0, 0), gpu(1, 50)], 1000);
  assert.strictEqual(t.idleSince(0), 1000);
  assert.strictEqual(t.idleSince(1), null);
  assert.strictEqual(t.idleSince(7), null);
});

test('annotate adds idleSince to each gpu entry', () => {
  const t = new IdleTracker();
  const gpus = [gpu(0, 0), gpu(1, 90)];
  t.update(gpus, 1000);
  assert.deepStrictEqual(
    t.annotate(gpus).map((g) => g.idleSince),
    [1000, null]
  );
});

test('a GPU missing from a sample loses its idle state, so a reused id starts fresh', () => {
  const t = new IdleTracker();
  t.update([gpu(0, 0), gpu(1, 0)], 1000);
  t.update([gpu(1, 0)], 2000);
  assert.strictEqual(t.idleSince(0), null);
  t.update([gpu(0, 0), gpu(1, 0)], 3000);
  assert.strictEqual(t.idleSince(0), 3000);
  assert.strictEqual(t.idleSince(1), 1000);
});
