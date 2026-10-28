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
    { server: 'GPU Server 1', label: 'GPU 3', idleMs: 12 * 3600_000 },
    { server: 'GPU Server 2', label: 'GPU 0', idleMs: 36 * 3600_000 },
  ]);
  assert.equal(card.type, 'AdaptiveCard'); assert.equal(card.version, '1.4');
  assert.equal(card.body[0].text, '⚠️ GPUs ociosas há mais de 12h');
  assert.equal(card.body[0].color, 'Attention');
  const rows = card.body.filter((b) => b.type === 'ColumnSet');
  assert.deepEqual(rows[0].columns.map((c) => c.items[0].text), ['Servidor', 'GPU', 'Ociosa há']);
  assert.deepEqual(rows.slice(1).map((r) => r.columns.map((c) => c.items[0].text)),
    [['GPU Server 2', 'GPU 0', '36:00:00'], ['GPU Server 1', 'GPU 3', '12:00:00']]);
  assert.equal(rows[1].separator, true);
  assert.equal(rows[1].columns[2].items[0].fontType, 'Monospace');
});

test('a 40-row idle card stays under 28 KB', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ server: `Server ${i}`, label: `GPU ${i} - 1`, idleMs: i * 3600_000 }));
  assert.ok(Buffer.byteLength(JSON.stringify(envelope(idleCard(rows)))) < 28 * 1024);
});

test('downCard and recoveryCard wording', () => {
  const now = new Date(2026, 9, 23, 12, 0).getTime();
  const down = downCard({ server: 'GPU Server 2', downSince: now - 45 * 60_000, error: 'ssh timeout', now });
  assert.equal(down.body[0].text, '🔴 GPU Server 2 inacessível');
  assert.equal(down.body[0].color, 'Attention');
  const dt = texts(down).join('\n');
  assert.match(dt, /Sem resposta desde 23\/10 11:15/);
  assert.match(dt, /\(há 45min\)/);
  assert.match(dt, /Último erro: ssh timeout/);

  const downSince = new Date(2026, 9, 23, 9, 0).getTime();
  const rec = recoveryCard({ server: 'GPU Server 2', downSince, recoveredAt: downSince + (2 * 60 + 13) * 60_000 });
  assert.equal(rec.body[0].text, '✅ GPU Server 2 voltou');
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

test('postCard never leaks the URL when fetch rejects', async () => {
  const leak = async () => { throw new TypeError('request to https://x/secret-token failed'); };
  await assert.rejects(
    postCard('https://x/secret-token', idleCard([]), { fetchFn: leak }),
    (e) => !e.message.includes('secret-token') && !e.message.includes('https://') && e.cause === undefined);
  const timeout = async () => { const e = new Error('aborted https://x/secret-token'); e.name = 'TimeoutError'; throw e; };
  await assert.rejects(
    postCard('https://x/secret-token', idleCard([]), { fetchFn: timeout }),
    (e) => /timeout/.test(e.message) && !e.message.includes('secret-token'));
});

test('card text is clipped', () => {
  const idle = idleCard([{ server: 'S'.repeat(500), label: 'L'.repeat(500), idleMs: 1000 }]);
  const cells = idle.body.filter((b) => b.type === 'ColumnSet')[1].columns.map((c) => c.items[0].text);
  assert.ok(cells[0].length <= 80 && cells[0].endsWith('…'));
  assert.ok(cells[1].length <= 80 && cells[1].endsWith('…'));
  const err = Array.from({ length: 200 }, () => 'line of error').join('\n');
  const down = downCard({ server: 'S'.repeat(500), downSince: 0, error: err, now: 60_000 });
  assert.ok(down.body[0].text.length <= 80 + '🔴  inacessível'.length);
  const line = down.body[2].text;
  assert.ok(line.startsWith('Último erro: ') && line.length <= 300 && line.endsWith('…') && !/\n/.test(line));
  assert.ok(recoveryCard({ server: 'S'.repeat(500), downSince: 0, recoveredAt: 1 }).body[0].text.length <= 80 + '✅  voltou'.length);
});

test('40 rows with 700-char names and labels stay under 28 KB', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ server: 'S'.repeat(700), label: 'L'.repeat(700), idleMs: i * 3600_000 }));
  assert.ok(Buffer.byteLength(JSON.stringify(envelope(idleCard(rows)))) < 28 * 1024);
});

test('idleCard caps rows at 30 and summarises the rest', () => {
  const rows = Array.from({ length: 45 }, (_, i) => ({ server: `S${i}`, label: 'G', idleMs: i * 3600_000 }));
  const body = idleCard(rows).body;
  const sets = body.filter((b) => b.type === 'ColumnSet');
  assert.equal(sets.length, 31);
  assert.equal(body[body.length - 1].text, '+ 15 outras GPUs ociosas há mais de 12h');
  assert.equal(body[body.length - 1].isSubtle, true);
  assert.equal(sets[1].columns[0].items[0].text, 'S44');
  assert.equal(sets[30].columns[0].items[0].text, 'S15');
});

test('200 rows with 700-char names and labels stay under 28 KB', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ server: 'S'.repeat(700), label: 'L'.repeat(700), idleMs: i * 3600_000 }));
  assert.ok(Buffer.byteLength(JSON.stringify(envelope(idleCard(rows)))) < 28 * 1024);
});
