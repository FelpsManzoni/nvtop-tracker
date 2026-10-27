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

// Collapse whitespace and truncate so card text can't blow Teams' 28 KB limit.
function clip(text, max) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
const NAME_MAX = 80;
const ERROR_LINE_MAX = 300;

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

const IDLE_CARD_MAX_ROWS = 30;

function idleCard(rows) {
  const head = { weight: 'Bolder', isSubtle: true };
  const all = [...rows].sort((a, b) => b.idleMs - a.idleMs);
  const sorted = all.slice(0, IDLE_CARD_MAX_ROWS);
  const extra = all.length - sorted.length;
  return card([
    title('⚠️ GPUs ociosas há mais de 12h', 'Attention'),
    row([
      cell('Servidor', 'stretch', head),
      cell('GPU', 'auto', head),
      cell('Ociosa há', 'auto', { ...head, horizontalAlignment: 'Right' }),
    ]),
    ...sorted.map((r, i) => row([
      cell(clip(r.server, NAME_MAX), 'stretch', { wrap: true }),
      cell(clip(r.label, NAME_MAX), 'auto'),
      cell(fmtHms(r.idleMs), 'auto', { horizontalAlignment: 'Right', fontType: 'Monospace' }),
    ], i === 0 ? { separator: true } : {})),
    ...(extra > 0
      ? [{ type: 'TextBlock', text: `+ ${extra} outras GPUs ociosas há mais de 12h`, isSubtle: true, wrap: true }]
      : []),
  ]);
}

function downCard({ server, downSince, error, now }) {
  return card([
    title(`🔴 ${clip(server, NAME_MAX)} inacessível`, 'Attention'),
    { type: 'TextBlock', wrap: true, text: `Sem resposta desde ${fmtWhen(downSince)} (há ${fmtDuration(now - downSince)})` },
    { type: 'TextBlock', wrap: true, isSubtle: true, text: clip(`Último erro: ${error}`, ERROR_LINE_MAX) },
  ]);
}

function recoveryCard({ server, downSince, recoveredAt }) {
  return card([
    title(`✅ ${clip(server, NAME_MAX)} voltou`, 'Good'),
    { type: 'TextBlock', wrap: true, text: `Ficou inacessível por ${fmtDuration(recoveredAt - downSince)} (desde ${fmtWhen(downSince)})` },
  ]);
}

const envelope = (content) => ({
  type: 'message',
  attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content }],
});

// Resolves on any 2xx; errors never include the (secret) URL.
async function postCard(url, content, { fetchFn = fetch, timeoutMs = 10_000 } = {}) {
  let res;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope(content)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Original error may embed the URL; throw a fixed message, no cause.
    const kind = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'network error';
    throw new Error(`teams webhook: request failed (${kind})`);
  }
  if (!res.ok) throw new Error(`teams webhook: HTTP ${res.status}`);
}

module.exports = { IDLE_CARD_MAX_ROWS, fmtHms, fmtDuration, fmtWhen, idleCard, downCard, recoveryCard, envelope, postCard };
