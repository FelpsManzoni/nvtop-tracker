# Idle Alerts and Teams Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tint GPU cards by idle time (≥ 4 h yellow, ≥ 12 h red with a "!" pill) and post Adaptive Cards to a Teams Workflows webhook for GPUs idle ≥ 12 h (every 12 h milestone, batched) and for servers unreachable ≥ 5 min (hourly reminders, recovery message).

**Architecture:**
- **`src/teams.js`** builds the Adaptive Cards and POSTs them with Node's built-in `fetch`.
- **`src/notifier.js`** is a pure state machine. The collector feeds it each GPU poll result through `observe()`. Once a minute, `tick()` decides which messages are due, sends them through an injected sender, and records each one only after the send succeeds.
- **Notifier state** persists through the existing atomic `idleStore`, in a sibling file next to the idle history.
- **Card tint** is computed in the browser by the existing 1-second idle ticker.

**Tech Stack:** Node.js ≥ 18 (global `fetch`, `AbortSignal.timeout`), Express, `node:test`, vanilla JS frontend. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-23-idle-alerts-notifications-design.md`

## Global Constraints

- **Constants (not config):**
  - card tint: `IDLE_WARN_MS = 4 h`, `IDLE_ALERT_MS = 12 h`;
  - notifier: `IDLE_NOTIFY_STEP_MS = 12 h`, `DOWN_NOTICE_AFTER_MS = 5 min`, `DOWN_REMINDER_MS = 1 h`;
  - collector: `NOTIFY_INTERVAL_MS = 60 s`;
  - `POST_TIMEOUT_MS = 10 s`.
- **Idle time** = `now - idleSince` of an entry with a finite `utilization` on a server whose GPU poll is not failing. Unknown-utilization and down-server entries are never idle for alerts. The dashboard tint uses the same live timer, and only on `.gpu-idle` pills, which already exclude `offline`/`n/a`/`MIG`.
- **Webhook envelope:** `{ "type": "message", "attachments": [{ "contentType": "application/vnd.microsoft.card.adaptive", "content": <AdaptiveCard v1.4> }] }`, sent with `Content-Type: application/json`. Any 2xx counts as success; the flow answers `202`.
- **Idle card:**
  - title `⚠️ GPUs ociosas há mais de 12h` (`Bolder`, `Medium`, `color: Attention`, `wrap`);
  - a `ColumnSet` header `Servidor` (stretch) / `GPU` (auto) / `Ociosa há` (auto, right), all `Bolder` and `isSubtle`;
  - one `ColumnSet` per row, the first with `separator: true`, all with spacing `Small`: server (`wrap`), GPU label, idle time `hh:mm:ss` with unbounded hours (right-aligned, `fontType: Monospace`);
  - rows sorted by idle time, longest first.
- **Down card:**
  - title `🔴 <server> inacessível` (`Attention`);
  - `Sem resposta desde <dd/mm HH:MM> (há <duration>)`;
  - subtle `Último erro: <error>`.
- **Recovery card:**
  - title `✅ <server> voltou` (`color: Good`);
  - `Ficou inacessível por <duration> (desde <dd/mm HH:MM>)`.
- **Durations and times:** `<duration>` is `XhYYmin` / `Ymin` (e.g. `2h13min`, `45min`); `<dd/mm HH:MM>` is in the tracker host's local time.
- **Config:** `teamsWebhookUrl`, default `""`; empty disables notifications.
  - Must be a string.
  - If non-empty, it must start with `https://` and contain no `\`. Otherwise startup throws `config.teamsWebhookUrl must be an https URL without backslashes`.
  - The URL is never logged and never sent to the browser.
- **Commits:** branch `feat/idle-alerts-notifications`.
  - Titles match `^(feature|feat|fix|docs|refactor|experiment|hotfix|test|chore): .+`.
  - Messages end with these trailer lines, copied verbatim:
    ```
    Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
    Claude-Session: https://claude.ai/code/session_01DW6DKVihcwiQtNwhKmuinD
    ```
  - Author and committer must be `felipemanzoni3@gmail.com`; check with `git log -1 --format='%ae %ce'`.
  - Never push or merge.
- **Environment note:** while the user's `~/.gitconfig` has an empty `gpg.format`, run git with `GIT_CONFIG_GLOBAL=/home/fmanzoni-lx/.cache/gitconfig-claude-fixed`.

## Review Focus

1. **Restart after messages were sent:** idle milestones and down notices already sent must not be re-sent. Test: state round-trip in Task 2, and collector restart in Task 3.
2. **GPU-only outage while disk polls still succeed:** no idle report for that server's GPUs; the down notice and reminders still go out. Test in Task 3.
3. **Teams returns 4xx/5xx or times out:** nothing is recorded as sent, the message is retried on the next tick, and polling is unaffected. Tests in Task 1 (sender throws) and Task 2 (no commit on failure).
4. **A large batch** (e.g. 40 GPU rows) stays under Teams' 28 KB limit. Test in Task 1 on the serialized size.
5. **A GPU crossing 12 h while another is already at 30 h:** one message lists both. When the first reaches 24 h, a new message lists both again. When the second reaches 36 h, it does too. Test in Task 2.

---

### Task 1: Teams cards and sender

**Files:**
- Create: `src/teams.js`
- Modify: `src/config.js` (default + validation)
- Test: `test/teams.test.js` (new), `test/collector.test.js` (config validation test next to the existing `loadConfig` tests)

**Interfaces:**
- Produces (exports of `src/teams.js`):
  - `fmtHms(ms) → string`: `"12:04:31"`, unbounded hours (`"212:40:11"`).
  - `fmtDuration(ms) → string`: `"2h13min"`, `"45min"`, `"0min"` (floors minutes).
  - `fmtWhen(ts) → string`: `"dd/mm HH:MM"` in local time.
  - `idleCard(rows) → AdaptiveCard`, where `rows: [{ server, label, idleMs }]` (sorted inside, longest first).
  - `downCard({ server, downSince, error, now }) → AdaptiveCard`.
  - `recoveryCard({ server, downSince, recoveredAt }) → AdaptiveCard`.
  - `envelope(card) → object`: the Teams `message` wrapper.
  - `async postCard(url, card, { fetchFn = fetch, timeoutMs = 10_000 } = {})`: POSTs `envelope(card)` and resolves on 2xx. Otherwise it throws `Error("teams webhook: HTTP <status>")`, or the fetch error for network failures and timeouts. The error message never includes the URL.
- Config: `teamsWebhookUrl: ''` default plus the validation in Global Constraints.

- [ ] **Step 1: Write failing tests in `test/teams.test.js`**

```js
test('fmtHms and fmtDuration', () => {
  assert.equal(fmtHms((12 * 3600 + 4 * 60 + 31) * 1000), '12:04:31');
  assert.equal(fmtHms((212 * 3600 + 40 * 60 + 11) * 1000), '212:40:11');
  assert.equal(fmtDuration((2 * 60 + 13) * 60_000 + 59_000), '2h13min');
  assert.equal(fmtDuration(45 * 60_000), '45min');
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
test('downCard and recoveryCard wording', () => { /* title '🔴 H200 Server 2 inacessível' color Attention; body text contains 'Sem resposta desde', '(há 45min)', 'Último erro: ssh timeout'; recovery title '✅ H200 Server 2 voltou' color Good and text contains 'Ficou inacessível por 2h13min' */ });
test('postCard sends the envelope and resolves on 202', async () => { /* fake fetchFn records (url, init); assert init.method 'POST', header Content-Type application/json, JSON.parse(init.body).attachments[0].contentType === 'application/vnd.microsoft.card.adaptive' */ });
test('postCard throws on non-2xx without leaking the URL', async () => { /* fetchFn → { ok:false, status:400 }; await assert.rejects(..., (e) => /HTTP 400/.test(e.message) && !e.message.includes('secret')) with url 'https://x/secret' */ });
```

In `test/collector.test.js`, add `loadConfig rejects a bad teamsWebhookUrl`. It must throw `/teamsWebhookUrl/` for each of `42`, `'http://x'` and `'https://x/invoke?api-version\\=1'`, and `''` must load fine.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/teams.test.js test/collector.test.js`
Expected: FAIL with `Cannot find module '../src/teams'`, and the config test fails.

- [ ] **Step 3: Implement `src/teams.js` and the config validation** per the Interfaces and Global Constraints. Pass `signal: AbortSignal.timeout(timeoutMs)` to `fetch`.

- [ ] **Step 4: Run `npm test`**
Expected: all pass, with pristine output.

- [ ] **Step 5: Commit**
```bash
git add src/teams.js src/config.js test/teams.test.js test/collector.test.js
git commit -m "feat: build Teams Adaptive Cards and post them to a Workflows webhook" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DW6DKVihcwiQtNwhKmuinD"
```

---

### Task 2: Notifier state machine

**Files:**
- Create: `src/notifier.js`
- Test: `test/notifier.test.js` (new)

**Interfaces:**
- Consumes: Task 1's `idleCard`, `downCard`, `recoveryCard`.
- Produces:
  - `class Notifier`, constructed as `new Notifier({ send, saved })`.
    - `send: async (card) => void` rejects on failure.
    - `saved` is the persisted state, `{ [server]: ServerState }` or `undefined`.
  - `observe(server, { ok: true, entries, now })` or `observe(server, { ok: false, error, now })`. It is called after every GPU poll.
    - `entries` are the annotated GPU entries: `{ key, label, utilization, idleSince }`.
    - `ok: false` sets `downSince` (if unset) and `lastError`.
    - `ok: true` clears the outage. If a notice was sent for it, it sets `recoveryPending: { downSince, recoveredAt: now }`.
  - `async tick(now)` sends, in order:
    1. each server's pending recovery;
    2. each due down notice or reminder;
    3. at most one idle message.

    Each one is recorded only after `send` resolves. A rejected `send` is caught and logged (without the URL), and that message is left due. One failure must not stop the other messages in the same tick.
  - `toJSON() → { [server]: ServerState }`, where `ServerState = { downSince, lastError, noticeAt, recoveryPending, idle: { [key]: { idleSince, milestone } } }`. The constructor normalizes saved state (finite numbers or `null`) and **drops a saved outage whose `noticeAt` is null**.
  - Exported constants: `IDLE_NOTIFY_STEP_MS`, `DOWN_NOTICE_AFTER_MS`, `DOWN_REMINDER_MS`.
- Idle rules for `tick`:
  - An entry is idle when `Number.isFinite(utilization)` and `idleSince != null`, and its server has no `downSince`. Its milestone is `Math.floor((now - idleSince) / IDLE_NOTIFY_STEP_MS)`.
  - The entry is due when its milestone is ≥ 1 and the saved record is missing, has a different `idleSince`, or has a lower milestone.
  - If any entry is due, send one `idleCard` of **all** idle entries with milestone ≥ 1, across all servers, using `{ server, label, idleMs }`. On success, record `{ idleSince, milestone }` for each listed entry.
  - Saved idle records whose key is no longer idle are deleted on each `tick`.

- [ ] **Step 1: Write failing tests in `test/notifier.test.js`**

Use `H = 3600_000`, a fake `send` that pushes cards into `sent` (and can be switched to reject), and helpers like `gpu(key, idleSince)` → `{ key, label: 'GPU ' + key, utilization: 0, idleSince }`.

```js
test('no message before 12h; one at 12h; none again until 24h', async () => { /* observe ok with gpu('3', 0); tick(11.9*H) → 0 sent; tick(12*H) → 1 sent listing GPU 3 '12:00:00'; tick(13*H) → still 1; tick(24*H) → 2 */ });
test('batching: a new crossing lists every GPU idle ≥ 12h, across servers', async () => { /* S1 gpu('3', 0); S2 gpu('0', -18*H) (observe both before each tick); tick(1*H) → 1 sent, rows [S2 GPU 0 '19:00:00']; tick(12*H) → 2nd sent, rows [S2 GPU 0 '30:00:00', S1 GPU 3 '12:00:00']; tick(17*H) → still 2; tick(18*H) → 3rd (S2 crosses 36h), rows [S2 '36:00:00', S1 '18:00:00']; tick(24*H) → 4th (S1 crosses 24h), rows [S2 '42:00:00', S1 '24:00:00'] */ });
test('a GPU that became busy and idle again starts over', async () => { /* notified at 12h; observe gpu('3', 20*H) (new idleSince); tick(31*H) → nothing new; tick(32*H) → sent */ });
test('unknown utilization and down servers are never reported idle', async () => { /* utilization null entry idle 20h → nothing; server observed ok:false → its idle entries ignored */ });
test('a failed send records nothing and is retried next tick', async () => { /* send rejects at 12h → 0 recorded; next tick (12h+1min) with send ok → 1 sent */ });
test('restart: toJSON/fromJSON does not re-send', async () => { /* sent at 12h; new Notifier({ send, saved: JSON.parse(JSON.stringify(n.toJSON())) }); observe same entries; tick(13*H) → nothing */ });
test('first run with no saved state sends one catch-up message', async () => { /* gpu idle 40h, empty state → one message on first tick */ });
test('server down: nothing before 5 min, notice at 5 min, reminder every hour, recovery once', async () => {
  // observe(S, {ok:false, error:'ssh timeout', now: 0}); tick(4*60_000) → 0;
  // tick(5*60_000) → down card; tick(30*60_000) → none; tick(65*60_000) → reminder;
  // observe(S, {ok:true, entries:[], now: 70*60_000}); tick(71*60_000) → recovery card (duration from downSince 0)
});
test('an outage shorter than 5 minutes sends nothing, including no recovery', async () => { /* down at 0, ok at 3min, ticks → 0 sent */ });
test('a failed recovery send is retried', async () => { /* send rejects on recovery → retried next tick */ });
test('a saved outage without a notice is dropped on load; one with a notice still recovers', () => { /* constructor normalization */ });
```

- [ ] **Step 2: Run the tests to verify they fail**
Run: `node --test test/notifier.test.js`
Expected: FAIL with `Cannot find module '../src/notifier'`.

- [ ] **Step 3: Implement `src/notifier.js`** per the Interfaces.

- [ ] **Step 4: Run `npm test`**
Expected: all pass, with pristine output.

- [ ] **Step 5: Commit**
```bash
git add src/notifier.js test/notifier.test.js
git commit -m "feat: decide idle and unreachable Teams notifications" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DW6DKVihcwiQtNwhKmuinD"
```

---

### Task 3: Wire the notifier into the collector

**Files:**
- Modify: `src/collector.js`, `README.md`, `config.example.json`
- Test: `test/collector.test.js`

**Interfaces:**
- Consumes: Task 1's `postCard` and Task 2's `Notifier`.
- Produces:
  - `collector.notifier`, a `Notifier` instance, or `null` when `teamsWebhookUrl` is empty.
  - `collector.notifierStateFile`, which is `path.join(path.dirname(this.idleHistoryFile), 'notifier-state.json')`.
  - `async collector.tickNotifier(now = Date.now())`. It is a no-op when the notifier is `null`, and it never throws.

- [ ] **Step 1: Write failing tests in `test/collector.test.js`**

Use the existing `setup()` with `teamsWebhookUrl: 'https://example.invalid/hook'` and replace `collector.notifier.send` (or inject through a `sendCard` test hook the collector passes to `Notifier`) with a fake that records cards.

```js
test('a GPU poll failure is observed as down and a disk success does not clear it', async () => { /* make GPU query reject; await _pollGpu; make disk query succeed; await _pollDisk; collector.notifier.toJSON()['s'].downSince is a number */ });
test('tickNotifier sends a down card after 5 minutes of GPU poll failures', async () => { /* first failed _pollGpu at real time T; await collector.tickNotifier(T + 5*60_000) → 1 card with title containing 'inacessível' */ });
test('notifier state is saved with the idle history and restored on restart', async () => { /* after a sent down notice, stop() writes notifier-state.json next to the idle file; a second collector over the same idle file has the same noticeAt */ });
test('no notifier and no extra timer when teamsWebhookUrl is empty', () => { /* collector.notifier === null; start() with mocked setInterval registers no 60 s notifier timer beyond the existing idle-save one */ });
```

- [ ] **Step 2: Run the tests to verify they fail**
Run: `node --test test/collector.test.js`
Expected: FAIL. `collector.notifier` is undefined.

- [ ] **Step 3: Implement**
  - **Constructor:**
    - If `config.teamsWebhookUrl` is non-empty, load `idleStore.load(this.notifierStateFile)`.
    - Build `new Notifier({ send: (card) => postCard(config.teamsWebhookUrl, card), saved })`, or set `this.notifier = null` when the URL is empty.
  - **`_pollGpu`:**
    - After the success-path `Object.assign`, call `this.notifier?.observe(server.name, { ok: true, entries: state.gpu, now })`.
    - In the `catch`, call `this.notifier?.observe(server.name, { ok: false, error: err.message, now: Date.now() })`.
  - **`start()`:** when the notifier exists, push `setInterval(() => this.tickNotifier(), NOTIFY_INTERVAL_MS)` (60 s).
  - **`saveIdleHistory()`:** also `idleStore.save(this.notifierStateFile, this.notifier.toJSON())` when the notifier exists, inside the same try/catch pattern, logging without the URL.
  - **`stop()`:** already calls `saveIdleHistory()`.
  - **Docs:**
    - `README.md`: add a Features bullet (Teams alerts: GPUs idle ≥ 12 h every 12 h, batched; servers unreachable ≥ 5 min with hourly reminders and a recovery message).
    - `README.md`: add a short "Teams notifications" section with the Workflows steps — channel "…" → Workflows → "Send webhook alerts to a channel", the trigger access must be "Anyone", copy the full URL, and on zsh check it has no `\`.
    - `README.md`: add a config-table row for `teamsWebhookUrl`.
    - `config.example.json`: add `"teamsWebhookUrl": ""`.

- [ ] **Step 4: Run `npm test`**
Expected: all pass, with pristine output. Tests must not write into the repo's `data/`; they use temp idle files as the existing tests do.

- [ ] **Step 5: Commit**
```bash
git add src/collector.js README.md config.example.json test/collector.test.js
git commit -m "feat: send Teams notifications for idle GPUs and unreachable servers" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DW6DKVihcwiQtNwhKmuinD"
```

---

### Task 4: Dashboard idle escalation

**Files:**
- Modify: `public/app.js` (`paintIdle` / idle ticker), `public/style.css`

**Interfaces:**
- Consumes: the existing `.gpu-idle` pill with `data-idle-ms` / `data-received-at`, inside `.gpu-graph-card`.

- [ ] **Step 1: Implement**
  - **Constants:** in `public/app.js`, `IDLE_WARN_MS = 4 * 3600_000` and `IDLE_ALERT_MS = 12 * 3600_000`.
  - **`paintIdle(el)`:** compute the idle ms as `idleLabel` does.
    - Toggle `idle-warn` on `el.closest('.gpu-graph-card')` when the GPU is idle and `idleMs >= IDLE_WARN_MS && idleMs < IDLE_ALERT_MS`, and `idle-alert` when it is idle and `idleMs >= IDLE_ALERT_MS`. Remove both otherwise, including "in use".
    - For `idle-alert`, add class `alert` to the pill and prefix the text with `! ` (e.g. `! 12:04:31`).
  - **`style.css`:**
    - `.gpu-graph-card.idle-warn` gets a light-yellow tint and `.gpu-graph-card.idle-alert` a light-red tint. Text must stay readable on the dark theme; pick values close to the existing palette, e.g. a `#3b3622`-ish warm tint and a `#43282a`-ish red tint, with a matching 1 px border.
    - `.gpu-idle.alert` gets a red pill (`background: #a3262c; color: #fff; font-weight: 600`).
  - Cards in `offline`, `n/a` or `MIG` state have no `.gpu-idle` element, so they are never tinted. Keep it that way.

- [ ] **Step 2: Check**
Run: `node --check public/app.js && npm test`
Expected: no syntax error; all tests pass.

- [ ] **Step 3: Commit**
```bash
git add public/app.js public/style.css
git commit -m "feat: tint GPU cards after 4h and 12h of idle time" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DW6DKVihcwiQtNwhKmuinD"
```

- [ ] **Step 4: Verify in the browser (controller)**
  - **Setup:** run the app on a spare port with a preload override (port + temp idle file). The user's service on :3000 stays untouched.
  - **Tint check:** in a headless browser, set a card's `data-idle-ms` to 5 h and then 13 h and call `paintIdle`. Screenshot the yellow card, the red card and the `! hh:mm:ss` pill, and confirm the text is readable.
  - **Real messages:** only with the user's go-ahead, send one real idle card and one down card to the channel through `collector.tickNotifier`, using forced state.
