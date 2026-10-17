const { test } = require('node:test');
const assert = require('node:assert');
const { IdleHistory } = require('../src/idleHistory');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// One sample per minute for GPU 0 at from, from + 1min, ... while t < to. Returns `to`.
function feed(h, utilization, from, to) {
  for (let t = from; t < to; t += MIN) h.update([{ id: 0, utilization }], t);
  return to;
}

test('worked example: 12h idle, 1m blip, 1h30m idle, sustained use -> one 13h31m period', () => {
  const h = new IdleHistory();
  let t = feed(h, 0, 0, 12 * HOUR);
  t = feed(h, 50, t, t + MIN);
  t = feed(h, 0, t, t + 90 * MIN);
  t = feed(h, 50, t, t + 3 * HOUR);
  assert.strictEqual(h.summary(0, t).lastIdleMs, 13 * HOUR + 31 * MIN);
});

test('an idle stretch of 10 minutes or less is never recorded', () => {
  const h = new IdleHistory();
  let t = feed(h, 0, 0, 11 * MIN); // samples 0..10m: idle for exactly 10 min
  t = feed(h, 50, t, t + 30 * MIN);
  assert.deepStrictEqual(h.summary(0, t), { idleSince: null, lastIdleMs: null, idle30dMs: 0 });
});

test('an idle stretch over 10 minutes is recorded and ends where activity began', () => {
  const h = new IdleHistory();
  let t = feed(h, 0, 0, 12 * MIN); // samples 0..11m: opens at 11m
  t = feed(h, 50, t, t + 30 * MIN); // busy from 12m
  assert.strictEqual(h.summary(0, t).lastIdleMs, 12 * MIN);
});

test('a busy blip of 9 minutes does not close the period; 11 minutes does', () => {
  const h = new IdleHistory();
  let t = feed(h, 0, 0, HOUR);
  t = feed(h, 50, t, t + 10 * MIN); // busy samples 60..69m -> at most 9 min busy
  assert.strictEqual(h.summary(0, t).lastIdleMs, null);
  t = feed(h, 0, t, t + 10 * MIN); // idle 70..79m
  t = feed(h, 50, t, t + 12 * MIN); // busy 80..91m -> 11 min busy at 91m, closes at 80m
  assert.strictEqual(h.summary(0, t).lastIdleMs, 80 * MIN);
});

test('a busy stretch of exactly 10 minutes is still absorbed', () => {
  const h = new IdleHistory();
  let t = feed(h, 0, 0, HOUR);
  t = feed(h, 50, t, t + 11 * MIN); // busy samples 60..70m: exactly 10 min busy at 70m
  t = feed(h, 0, t, t + MIN);
  assert.strictEqual(h.summary(0, t).lastIdleMs, null);
});

test('the live idleSince still resets on any activity', () => {
  const h = new IdleHistory();
  let t = feed(h, 0, 0, HOUR);
  assert.strictEqual(h.summary(0, t).idleSince, 0);
  t = feed(h, 50, t, t + MIN);
  assert.strictEqual(h.summary(0, t).idleSince, null);
  t = feed(h, 0, t, t + MIN);
  assert.strictEqual(h.summary(0, t).idleSince, 61 * MIN);
});

test('GPUs are tracked independently and unknown GPUs have an empty summary', () => {
  const h = new IdleHistory();
  h.update([{ id: 0, utilization: 0 }, { id: 1, utilization: 50 }], 1000);
  assert.strictEqual(h.summary(0, 1000).idleSince, 1000);
  assert.strictEqual(h.summary(1, 1000).idleSince, null);
  assert.deepStrictEqual(h.summary(7, 1000), { idleSince: null, lastIdleMs: null, idle30dMs: 0 });
});

test('a period crossing the 30-day boundary counts only its part inside the window', () => {
  const now = 100 * DAY;
  const h = IdleHistory.fromJSON({ 0: { lastSampleAt: now, periods: [{ start: now - 31 * DAY, end: now - 29 * DAY }] } });
  assert.strictEqual(h.summary(0, now).idle30dMs, DAY);
});

test('periods that ended more than 30 days ago are pruned on update', () => {
  const now = 100 * DAY;
  const h = IdleHistory.fromJSON({
    0: {
      lastSampleAt: now - MIN,
      periods: [
        { start: now - 40 * DAY, end: now - 35 * DAY },
        { start: now - 2 * DAY, end: now - DAY },
      ],
    },
  });
  h.update([{ id: 0, utilization: 50 }], now);
  assert.deepStrictEqual(h.toJSON()[0].periods, [{ start: now - 2 * DAY, end: now - DAY }]);
});

test('the open period is counted up to the last sample, not up to now', () => {
  const h = new IdleHistory();
  feed(h, 0, 0, HOUR + MIN); // samples 0..60m, open from 0
  assert.strictEqual(h.summary(0, HOUR).idle30dMs, HOUR);
  assert.strictEqual(h.summary(0, 5 * HOUR).idle30dMs, HOUR);
});

test('a 3-minute gap continues; a 6-minute gap closes at the last sample and starts fresh', () => {
  const short = new IdleHistory();
  feed(short, 0, 0, 30 * MIN); // last sample at 29m
  short.update([{ id: 0, utilization: 0 }], 32 * MIN);
  assert.deepStrictEqual(short.summary(0, 32 * MIN), { idleSince: 0, lastIdleMs: null, idle30dMs: 32 * MIN });

  const long = new IdleHistory();
  feed(long, 0, 0, 30 * MIN);
  long.update([{ id: 0, utilization: 0 }], 35 * MIN);
  assert.deepStrictEqual(long.summary(0, 35 * MIN), { idleSince: 35 * MIN, lastIdleMs: 29 * MIN, idle30dMs: 29 * MIN });
});

test('a gap discards an idle stretch that never reached 10 minutes', () => {
  const h = new IdleHistory();
  feed(h, 0, 0, 5 * MIN); // last sample at 4m
  h.update([{ id: 0, utilization: 0 }], 15 * MIN);
  assert.deepStrictEqual(h.summary(0, 15 * MIN), { idleSince: 15 * MIN, lastIdleMs: null, idle30dMs: 0 });
});

test('toJSON/fromJSON round-trips and the restored history keeps working', () => {
  const h = new IdleHistory();
  let t = feed(h, 0, 0, HOUR);
  const restored = IdleHistory.fromJSON(JSON.parse(JSON.stringify(h.toJSON())));
  assert.deepStrictEqual(restored.summary(0, t), h.summary(0, t));
  t = feed(restored, 50, t, t + 12 * MIN);
  assert.strictEqual(restored.summary(0, t).lastIdleMs, HOUR);
});

test('a partial or null saved entry does not crash', () => {
  const h = IdleHistory.fromJSON({ 0: { openStart: 0 }, 1: null });
  assert.strictEqual(typeof h.summary(0, 1000).idle30dMs, 'number');
  h.update([{ id: 0, utilization: 0 }, { id: 1, utilization: 0 }], 1000);
  assert.strictEqual(h.summary(1, 1000).idleSince, 1000);
  assert.strictEqual(IdleHistory.fromJSON(undefined).summary(0).lastIdleMs, null);
});

test('annotate spreads the summary onto each gpu entry', () => {
  const h = new IdleHistory();
  const gpus = [{ id: 0, utilization: 0 }, { id: 1, utilization: 90 }];
  h.update(gpus, 1000);
  assert.deepStrictEqual(h.annotate(gpus, 1000), [
    { id: 0, utilization: 0, idleSince: 1000, lastIdleMs: null, idle30dMs: 0 },
    { id: 1, utilization: 90, idleSince: null, lastIdleMs: null, idle30dMs: 0 },
  ]);
});

test('malformed saved periods and timestamps are dropped instead of breaking updates', () => {
  const h = IdleHistory.fromJSON({
    0: { idleSince: 'x', lastSampleAt: 1000, periods: [null, { start: 'a', end: 5 }, { start: 9, end: 3 }, { start: 100, end: 200 }] },
  });
  assert.doesNotThrow(() => h.update([{ id: 0, utilization: 0 }], 2000));
  assert.deepStrictEqual(h.toJSON()[0].periods, [{ start: 100, end: 200 }]);
  assert.strictEqual(h.summary(0, 2000).idleSince, 2000);
});

test('a backward clock jump closes the open period and starts fresh', () => {
  const h = new IdleHistory();
  feed(h, 0, 0, 30 * MIN); // open from 0, last sample at 29m
  h.update([{ id: 0, utilization: 0 }], 10 * MIN); // clock moved back 19 minutes
  const s = h.summary(0, 10 * MIN);
  assert.strictEqual(s.idleSince, 10 * MIN);
  assert.strictEqual(s.lastIdleMs, 29 * MIN);
});
