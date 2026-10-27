const { test } = require('node:test');
const assert = require('node:assert');
const {
  fmtHms, fmtDuration, fmtWhen, idleCard, downCard, recoveryCard, envelope, postCard,
} = require('../src/teams');

const texts = (card) => card.body.map((b) => b.text).filter(Boolean);

test('fmtHms and fmtDuration', () => {
  assert.equal(fmtHms((12 * 3600 + 4 * 60 + 31) * 1000), '12:04:31');
  assert.equal(fmtHms((212 * 3600 + 40 * 60 + 11) * 1000), '212:40:11');
  assert.equal(fmtDuration((2 * 60 + 13) * 60_000 + 59_000), '2h13min');
  assert.equal(fmtDuration(45 * 60_000), '45min');
  assert.equal(fmtDuration(0), '0min');
});

test('fmtWhen formats local time as dd/mm HH:MM', () => {
  assert.equal(fmtWhen(new Date(2026, 9, 23, 9, 5).getTime()), '23/10 09:05');
});

test('idleCard has the approved structure, rows longest first', () => {
  const card = idleCard([
    { server: 'H200 Server 1', label: 'GPU 3', idleMs: 12 * 3600_000 },
    { server: 'H200 Server 2', label: 'GPU 0', idleMs: 36 * 3600_000 },
  ]);
  assert.equal(card.type, 'AdaptiveCard'); assert.equal(card.version, '1.4');
  assert.equal(card.body[0].text, '⚠️ GPUs ociosas há mais de 12h');
  assert.equal(card.body[0].color, 'Attention');
  const rows = card.body.filter((b) => b.type === 'ColumnSet');
  assert.deepEqual(rows[0].columns.map((c) => c.items[0].text), ['Servidor', 'GPU', 'Ociosa há']);
  assert.deepEqual(rows.slice(1).map((r) => r.columns.map((c) => c.items[0].text)),
    [['H200 Server 2', 'GPU 0', '36:00:00'], ['H200 Server 1', 'GPU 3', '12:00:00']]);
  assert.equal(rows[1].separator, true);
  assert.equal(rows[1].columns[2].items[0].fontType, 'Monospace');
});

test('a 40-row idle card stays under 28 KB', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ server: `Server ${i}`, label: `GPU ${i} - 1`, idleMs: i * 3600_000 }));
  assert.ok(Buffer.byteLength(JSON.stringify(envelope(idleCard(rows)))) < 28 * 1024);
});

test('downCard and recoveryCard wording', () => {
  const now = new Date(2026, 9, 23, 12, 0).getTime();
  const down = downCard({ server: 'H200 Server 2', downSince: now - 45 * 60_000, error: 'ssh timeout', now });
  assert.equal(down.body[0].text, '🔴 H200 Server 2 inacessível');
  assert.equal(down.body[0].color, 'Attention');
  const dt = texts(down).join('\n');
  assert.match(dt, /Sem resposta desde 23\/10 11:15/);
  assert.match(dt, /\(há 45min\)/);
  assert.match(dt, /Último erro: ssh timeout/);

  const downSince = new Date(2026, 9, 23, 9, 0).getTime();
  const rec = recoveryCard({ server: 'H200 Server 2', downSince, recoveredAt: downSince + (2 * 60 + 13) * 60_000 });
  assert.equal(rec.body[0].text, '✅ H200 Server 2 voltou');
  assert.equal(rec.body[0].color, 'Good');
  assert.match(texts(rec).join('\n'), /Ficou inacessível por 2h13min \(desde 23\/10 09:00\)/);
});

test('postCard sends the envelope and resolves on 202', async () => {
  const calls = [];
  const fetchFn = async (url, init) => { calls.push([url, init]); return { ok: true, status: 202 }; };
  await postCard('https://x/hook', recoveryCard({ server: 's', downSince: 0, recoveredAt: 60_000 }), { fetchFn });
  const [url, init] = calls[0];
  assert.equal(url, 'https://x/hook');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(JSON.parse(init.body).attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  assert.ok(init.signal);
});

test('postCard throws on non-2xx without leaking the URL', async () => {
  const fetchFn = async () => ({ ok: false, status: 400 });
  await assert.rejects(
    postCard('https://x/secret', idleCard([]), { fetchFn }),
    (e) => /HTTP 400/.test(e.message) && !e.message.includes('secret'));
});
