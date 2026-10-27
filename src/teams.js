// Teams Adaptive Cards (v1.4) and the Workflows webhook sender.
const pad = (n) => String(n).padStart(2, '0');

// 12:04:31, hours unbounded.
function fmtHms(ms) {
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

// 2h13min / 45min (floors minutes).
function fmtDuration(ms) {
  const min = Math.floor(ms / 60_000);
  return min >= 60 ? `${Math.floor(min / 60)}h${pad(min % 60)}min` : `${min}min`;
}

// dd/mm HH:MM in the host's local time.
function fmtWhen(ts) {
  const d = new Date(ts);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const title = (text, color) => ({
  type: 'TextBlock', text, weight: 'Bolder', size: 'Medium', color, wrap: true,
});
const card = (body) => ({
  $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
  type: 'AdaptiveCard',
  version: '1.4',
  body,
});
const cell = (text, width, opts = {}) => ({
  type: 'Column',
  width,
  items: [{ type: 'TextBlock', text, ...opts }],
  ...(opts.horizontalAlignment ? { horizontalAlignment: opts.horizontalAlignment } : {}),
});
const row = (cells, extra = {}) => ({ type: 'ColumnSet', spacing: 'Small', columns: cells, ...extra });

function idleCard(rows) {
  const head = { weight: 'Bolder', isSubtle: true };
  const sorted = [...rows].sort((a, b) => b.idleMs - a.idleMs);
  return card([
    title('⚠️ GPUs ociosas há mais de 12h', 'Attention'),
    row([
      cell('Servidor', 'stretch', head),
      cell('GPU', 'auto', head),
      cell('Ociosa há', 'auto', { ...head, horizontalAlignment: 'Right' }),
    ]),
    ...sorted.map((r, i) => row([
      cell(r.server, 'stretch', { wrap: true }),
      cell(r.label, 'auto'),
      cell(fmtHms(r.idleMs), 'auto', { horizontalAlignment: 'Right', fontType: 'Monospace' }),
    ], i === 0 ? { separator: true } : {})),
  ]);
}

function downCard({ server, downSince, error, now }) {
  return card([
    title(`🔴 ${server} inacessível`, 'Attention'),
    { type: 'TextBlock', wrap: true, text: `Sem resposta desde ${fmtWhen(downSince)} (há ${fmtDuration(now - downSince)})` },
    { type: 'TextBlock', wrap: true, isSubtle: true, text: `Último erro: ${error}` },
  ]);
}

function recoveryCard({ server, downSince, recoveredAt }) {
  return card([
    title(`✅ ${server} voltou`, 'Good'),
    { type: 'TextBlock', wrap: true, text: `Ficou inacessível por ${fmtDuration(recoveredAt - downSince)} (desde ${fmtWhen(downSince)})` },
  ]);
}

const envelope = (content) => ({
  type: 'message',
  attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content }],
});

// Resolves on any 2xx; errors never include the (secret) URL.
async function postCard(url, content, { fetchFn = fetch, timeoutMs = 10_000 } = {}) {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope(content)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`teams webhook: HTTP ${res.status}`);
}

module.exports = { fmtHms, fmtDuration, fmtWhen, idleCard, downCard, recoveryCard, envelope, postCard };
