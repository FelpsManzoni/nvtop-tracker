const test = require('node:test');
const assert = require('node:assert/strict');
const { Notifier } = require('../src/notifier');

const H = 3600_000;
const M = 60_000;
const gpu = (key, idleSince, utilization = 0) => ({ key, label: 'GPU ' + key, utilization, idleSince });

function make(saved) {
  const sent = [];
  const ctl = { fail: false };
  const send = async (card) => {
    if (ctl.fail) throw new Error('HTTP 500');
    sent.push(card);
  };
  const n = new Notifier({ send, saved });
  return { n, sent, ctl, send };
}
const rowsOf = (card) =>
  card.body.filter((b) => b.type === 'ColumnSet').slice(1)
    .map((r) => r.columns.map((c) => c.items[0].text));
const quiet = (t) => {
  const warns = [];
  t.mock.method(console, 'warn', (...a) => warns.push(a.join(' ')));
  return warns;
};

test('no message before 12h; one at 12h; none again until 24h', async () => {
  const { n, sent } = make();
  const obs = (now) => n.observe('S1', { ok: true, entries: [gpu('3', 0)], now });
  obs(11.9 * H); await n.tick(11.9 * H);
  assert.equal(sent.length, 0);
  obs(12 * H); await n.tick(12 * H);
  assert.equal(sent.length, 1);
  assert.deepEqual(rowsOf(sent[0]), [['S1', 'GPU 3', '12:00:00']]);
  obs(13 * H); await n.tick(13 * H);
  assert.equal(sent.length, 1);
  obs(24 * H); await n.tick(24 * H);
  assert.equal(sent.length, 2);
});

test('batching: a new crossing lists every GPU idle >= 12h, across servers', async () => {
  const { n, sent } = make();
  const step = async (now) => {
    n.observe('S1', { ok: true, entries: [gpu('3', 0)], now });
    n.observe('S2', { ok: true, entries: [gpu('0', -18 * H)], now });
    await n.tick(now);
  };
  await step(1 * H);
  assert.equal(sent.length, 1);
  assert.deepEqual(rowsOf(sent[0]), [['S2', 'GPU 0', '19:00:00']]);
  await step(12 * H);
  assert.equal(sent.length, 2);
  assert.deepEqual(rowsOf(sent[1]), [['S2', 'GPU 0', '30:00:00'], ['S1', 'GPU 3', '12:00:00']]);
  await step(17 * H);
  assert.equal(sent.length, 2);
  await step(18 * H);
  assert.equal(sent.length, 3);
  assert.deepEqual(rowsOf(sent[2]), [['S2', 'GPU 0', '36:00:00'], ['S1', 'GPU 3', '18:00:00']]);
  await step(24 * H);
  assert.equal(sent.length, 4);
  assert.deepEqual(rowsOf(sent[3]), [['S2', 'GPU 0', '42:00:00'], ['S1', 'GPU 3', '24:00:00']]);
});

test('a GPU that became busy and idle again starts over', async () => {
  const { n, sent } = make();
  n.observe('S1', { ok: true, entries: [gpu('3', 0)], now: 12 * H });
  await n.tick(12 * H);
  assert.equal(sent.length, 1);
  n.observe('S1', { ok: true, entries: [gpu('3', 20 * H)], now: 31 * H });
  await n.tick(31 * H);
  assert.equal(sent.length, 1);
  n.observe('S1', { ok: true, entries: [gpu('3', 20 * H)], now: 32 * H });
  await n.tick(32 * H);
  assert.equal(sent.length, 2);
  assert.deepEqual(rowsOf(sent[1]), [['S1', 'GPU 3', '12:00:00']]);
});

test('unknown utilization and down servers are never reported idle', async () => {
  const { n, sent } = make();
  n.observe('S1', { ok: true, entries: [gpu('3', 0, null)], now: 20 * H });
  await n.tick(20 * H);
  assert.equal(sent.length, 0);
  n.observe('S2', { ok: true, entries: [gpu('0', 0)], now: 20 * H - 1 });
  n.observe('S2', { ok: false, error: 'ssh timeout', now: 20 * H });
  await n.tick(20 * H);
  assert.equal(sent.length, 0);
});

test('a failed send records nothing and is retried next tick', async (t) => {
  const warns = quiet(t);
  const { n, sent, ctl } = make();
  n.observe('S1', { ok: true, entries: [gpu('3', 0)], now: 12 * H });
  ctl.fail = true;
  await n.tick(12 * H);
  assert.equal(sent.length, 0);
  assert.deepEqual(n.toJSON().S1.idle, {});
  assert.deepEqual(warns, ['notifier: send failed (HTTP 500)']);
  ctl.fail = false;
  n.observe('S1', { ok: true, entries: [gpu('3', 0)], now: 12 * H + M });
  await n.tick(12 * H + M);
  assert.equal(sent.length, 1);
});

test('restart: toJSON/fromJSON does not re-send', async () => {
  const a = make();
  a.n.observe('S1', { ok: true, entries: [gpu('3', 0)], now: 12 * H });
  await a.n.tick(12 * H);
  assert.equal(a.sent.length, 1);
  const b = make(JSON.parse(JSON.stringify(a.n.toJSON())));
  b.n.observe('S1', { ok: true, entries: [gpu('3', 0)], now: 13 * H });
  await b.n.tick(13 * H);
  assert.equal(b.sent.length, 0);
});

test('first run with no saved state sends one catch-up message', async () => {
  const { n, sent } = make();
  n.observe('S1', { ok: true, entries: [gpu('3', 0)], now: 40 * H });
  await n.tick(40 * H);
  assert.equal(sent.length, 1);
  assert.deepEqual(rowsOf(sent[0]), [['S1', 'GPU 3', '40:00:00']]);
});

test('server down: nothing before 5 min, notice at 5 min, reminder every hour, recovery once', async () => {
  const { n, sent } = make();
  const S = 'GPU Server 2';
  n.observe(S, { ok: false, error: 'ssh timeout', now: 0 });
  await n.tick(4 * M);
  assert.equal(sent.length, 0);
  n.observe(S, { ok: false, error: 'ssh timeout', now: 5 * M });
  await n.tick(5 * M);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body[0].text, `🔴 ${S} inacessível`);
  await n.tick(30 * M);
  assert.equal(sent.length, 1);
  await n.tick(65 * M);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body[0].text, `🔴 ${S} inacessível`);
  n.observe(S, { ok: true, entries: [], now: 70 * M });
  await n.tick(71 * M);
  assert.equal(sent.length, 3);
  assert.equal(sent[2].body[0].text, `✅ ${S} voltou`);
  assert.match(sent[2].body[1].text, /Ficou inacessível por 1h10min/);
  await n.tick(72 * M);
  assert.equal(sent.length, 3);
});

test('observing an already-down server keeps downSince and updates lastError', () => {
  const { n } = make();
  n.observe('S', { ok: false, error: 'a', now: 0 });
  n.observe('S', { ok: false, error: 'b', now: 10 * M });
  const s = n.toJSON().S;
  assert.equal(s.downSince, 0);
  assert.equal(s.lastError, 'b');
});

test('an outage shorter than 5 minutes sends nothing, including no recovery', async () => {
  const { n, sent } = make();
  n.observe('S', { ok: false, error: 'x', now: 0 });
  await n.tick(1 * M);
  n.observe('S', { ok: true, entries: [], now: 3 * M });
  await n.tick(4 * M);
  await n.tick(10 * M);
  assert.equal(sent.length, 0);
  assert.equal(n.toJSON().S.recoveryPending, null);
});

test('a failed recovery send is retried; recovery precedes down notices; one failure does not stop others', async (t) => {
  const warns = quiet(t);
  const { n, sent, ctl } = make();
  n.observe('A', { ok: false, error: 'x', now: 0 });
  await n.tick(5 * M);
  assert.equal(sent.length, 1);
  n.observe('A', { ok: true, entries: [], now: 6 * M });
  n.observe('B', { ok: false, error: 'y', now: 6 * M });
  ctl.fail = true;
  await n.tick(7 * M);
  assert.equal(sent.length, 1);
  assert.equal(warns.length, 1);
  ctl.fail = false;
  await n.tick(11 * M);
  assert.equal(sent.length, 3);
  assert.equal(sent[1].body[0].text, '✅ A voltou');
  assert.equal(sent[2].body[0].text, '🔴 B inacessível');
  // failure of one item does not block the next
  const f = make();
  const calls = [];
  f.n.send = async (card) => { calls.push(card.body[0].text); if (calls.length === 1) throw new Error('boom'); };
  f.n.observe('X', { ok: false, error: 'e', now: 0 });
  f.n.observe('Y', { ok: false, error: 'e', now: 0 });
  await f.n.tick(5 * M);
  assert.equal(calls.length, 2);
});

test('a saved outage without a notice is dropped on load; one with a notice still recovers', async () => {
  const saved = {
    A: { downSince: 0, lastError: 'x', noticeAt: null, recoveryPending: null, idle: {} },
    B: { downSince: 0, lastError: 'y', noticeAt: 5 * M, recoveryPending: null, idle: {} },
    C: { downSince: 'junk', recoveryPending: { downSince: 0, recoveredAt: 'bad' }, idle: { k: { idleSince: 'z', milestone: 1 } } },
  };
  const { n, sent } = make(saved);
  const j = n.toJSON();
  assert.equal(j.A.downSince, null);
  assert.equal(j.A.noticeAt, null);
  assert.equal(j.B.downSince, 0);
  assert.equal(j.C.downSince, null);
  assert.equal(j.C.recoveryPending, null);
  assert.deepEqual(j.C.idle, {});
  n.observe('B', { ok: true, entries: [], now: 20 * M });
  await n.tick(21 * M);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body[0].text, '✅ B voltou');
});

test('a short outage does not re-send an already-notified GPU', async () => {
  const { n, sent } = make();
  n.observe('S', { ok: true, entries: [gpu('0', 0)], now: 12 * H });
  await n.tick(12 * H);
  assert.equal(sent.length, 1);
  n.observe('S', { ok: false, error: 'x', now: 12 * H + M });
  await n.tick(12 * H + M);
  assert.equal(sent.length, 1);
  n.observe('S', { ok: true, entries: [gpu('0', 0)], now: 12 * H + 2 * M });
  await n.tick(12 * H + 2 * M);
  assert.equal(sent.length, 1);
  n.observe('S', { ok: true, entries: [gpu('0', 0)], now: 24 * H });
  await n.tick(24 * H);
  assert.equal(sent.length, 2);
});

test('a restart ticking before the first successful poll does not re-send', async () => {
  const a = make();
  a.n.observe('S', { ok: true, entries: [gpu('0', 0)], now: 12 * H });
  await a.n.tick(12 * H);
  assert.equal(a.sent.length, 1);
  const b = make(JSON.parse(JSON.stringify(a.n.toJSON())));
  await b.n.tick(12 * H + M);
  assert.equal(b.sent.length, 0);
  b.n.observe('S', { ok: true, entries: [gpu('0', 0)], now: 12 * H + 2 * M });
  await b.n.tick(12 * H + 2 * M);
  assert.equal(b.sent.length, 0);
  b.n.observe('S', { ok: true, entries: [gpu('0', 0)], now: 24 * H });
  await b.n.tick(24 * H);
  assert.equal(b.sent.length, 1);
});

test('a GPU that became busy on an observed-ok server is pruned and re-notified at its own 12h', async () => {
  const { n, sent } = make();
  n.observe('S', { ok: true, entries: [gpu('0', 0)], now: 12 * H });
  await n.tick(12 * H);
  assert.equal(sent.length, 1);
  n.observe('S', { ok: true, entries: [gpu('0', null, 80)], now: 13 * H });
  await n.tick(13 * H);
  assert.deepEqual(n.toJSON().S.idle, {});
  n.observe('S', { ok: true, entries: [gpu('0', 14 * H)], now: 26 * H });
  await n.tick(26 * H);
  assert.equal(sent.length, 2);
});

test('an unknown-utilization blip does not re-send a notified milestone', async () => {
  const { n, sent } = make();
  const at = (utilization, now) => n.observe('S', { ok: true, entries: [{ key: '7-1', label: 'GPU 7 - 1', utilization, idleSince: 0 }], now });
  at(0, 12 * H);
  await n.tick(12 * H);
  assert.equal(sent.length, 1);
  at(null, 12 * H + M);
  await n.tick(12 * H + M);
  assert.equal(sent.length, 1);
  at(0, 12 * H + 2 * M);
  await n.tick(12 * H + 2 * M);
  assert.equal(sent.length, 1);
  await n.tick(24 * H);
  assert.equal(sent.length, 2);
});

test('unknown(): a server whose data source failed is neither idle-reported nor down, and keeps its milestones', async () => {
  const { n, sent } = make();
  n.observe('S1', { ok: true, entries: [gpu('3', 0)], now: 12 * H });
  await n.tick(12 * H);
  assert.equal(sent.length, 1); // the 12h milestone

  n.unknown('S1');
  await n.tick(25 * H); // would be the 24h milestone if the old entries still counted
  assert.equal(sent.length, 0 + 1);
  assert.equal(n.toJSON().S1.downSince, null);

  n.observe('S1', { ok: true, entries: [gpu('3', 0)], now: 25 * H }); // same idleSince: due at 24h now
  await n.tick(25 * H);
  assert.equal(sent.length, 2);
});
