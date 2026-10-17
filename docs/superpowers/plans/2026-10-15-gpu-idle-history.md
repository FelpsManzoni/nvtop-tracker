# GPU Idle History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist per-GPU idle state to a small JSON file so it survives restarts, and show each GPU's "last idle" period and 30-day idle total in an extra card in the GPU graph grid.

**Architecture:** A pure `IdleHistory` class (one per server) runs the idle-period state machine and replaces today's `IdleTracker`. A tiny `idleStore` module loads/saves all servers' state to `data/idle-history.json` atomically. The `Collector` loads the store at construction, saves every 60 s and on `stop()`, and annotates each GPU entry in the SSE state with `idleSince`, `lastIdleMs`, `idle30dMs`; the frontend renders one extra "Idle history" card.

**Tech Stack:** Node.js (>= 18), Express, `node:test`, vanilla JS frontend. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-15-gpu-idle-history-design.md`

## Global Constraints

- Node >= 18 (`package.json` `engines`); no new npm dependencies.
- Thresholds (constants in `src/idleHistory.js`, not config): idle = utilization < 1%; `MIN_IDLE_MS` = 10 min; `MIN_BUSY_MS` = 10 min; `WINDOW_MS` = 30 days; `GAP_MS` = 5 min.
- Save interval: 60 s, plus on `collector.stop()` (triggered by `SIGTERM`/`SIGINT`).
- File: config `idleHistoryFile`, default `data/idle-history.json`, relative to the repo root or absolute; `data/` is gitignored.
- File shape: `{ "version": 1, "servers": { "<server name>": { "<gpu id>": { idleSince, busySince, openStart, lastSampleAt, periods: [{ start, end }] } } } }`.
- Durations in the UI: `hh:mm:ss`, hours unbounded (e.g. `212:40:11`); `—` when there is no closed period.
- The live idle timer / "in use" / "offline" tag and avatars on each GPU card keep their current behavior.
- Work on branch `feat/gpu-idle-history`. Commit titles match `^(feature|feat|fix|docs|refactor|experiment|hotfix|test|chore): .+`; every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01DW6DKVihcwiQtNwhKmuinD
  ```
- Never push, merge, or touch `stash@{0}`.

## Review Focus

1. **Restart within seconds** (e.g. `deploy/update.sh`): live timers and open periods must continue, not reset → collector test "stop() saves and a new collector resumes" (Task 3).
2. **Long outage / downtime**: an open period must be closed at the last known sample, and the 30-day total must not keep growing while no samples arrive → idleHistory tests "gap" and "open period counted up to the last sample" (Task 1).
3. **Corrupt or hand-edited file**: startup must never fail; a partial GPU entry (missing fields, `null`) must not crash → idleStore corrupt-file test (Task 2) and idleHistory "partial saved entry" test (Task 1).
4. **Unwritable data path** (permissions, parent is a file): saving must log and keep the dashboard running → collector test "a failing save does not throw" (Task 3).
5. **Crash mid-write**: the target file must never be half-written → idleStore round-trip test asserts no leftover `.tmp` and data written via temp + rename (Task 2).

---

### Task 1: `IdleHistory` state machine (replaces `IdleTracker`)

**Files:**
- Create: `src/idleHistory.js`
- Create: `test/idleHistory.test.js`
- Delete: `src/idleTracker.js`, `test/idleTracker.test.js`
- Modify: `src/collector.js:4` (import), `src/collector.js:52` (construction), `src/collector.js:106` (annotate)

**Interfaces:**
- Consumes: GPU entries from `parseGpuCsv` (`{ id: number, utilization: number, ... }`).
- Produces:
  - `class IdleHistory` exported as `{ IdleHistory }` from `src/idleHistory.js`
  - `new IdleHistory(saved?)` / `IdleHistory.fromJSON(saved?)` — `saved` is `{ [gpuId: string]: gpuState }` or `undefined`/`null`
  - `update(gpus: Array<{id, utilization}>, now: number = Date.now()): void`
  - `summary(id: number, now: number = Date.now()): { idleSince: number|null, lastIdleMs: number|null, idle30dMs: number }`
  - `annotate(gpus, now = Date.now())` → each gpu entry spread with its `summary`
  - `toJSON(): { [gpuId]: { idleSince, busySince, openStart, lastSampleAt, periods: [{start, end}] } }`

- [ ] **Step 1: Write the failing tests**

Create `test/idleHistory.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/idleHistory.test.js`
Expected: FAIL with `Cannot find module '../src/idleHistory'`.

- [ ] **Step 3: Implement `src/idleHistory.js`**

```js
// Per-GPU idle bookkeeping for one server: the live idle timer (idleSince) plus recorded idle
// periods for "last idle" and the 30-day total. Pure (no I/O) -- idleStore.js persists it.
// Rules: docs/superpowers/specs/2026-10-15-gpu-idle-history-design.md
const MIN_IDLE_MS = 10 * 60_000; // raw idle stretch needed to open a period
const MIN_BUSY_MS = 10 * 60_000; // continuous activity needed to close one
const WINDOW_MS = 30 * 24 * 60 * 60_000; // rolling window for the total, and retention
const GAP_MS = 5 * 60_000; // longer without a sample = unknown, so break state

function freshGpu() {
  return { idleSince: null, busySince: null, openStart: null, lastSampleAt: null, periods: [] };
}

class IdleHistory {
  constructor(saved) {
    this.gpus = new Map();
    for (const [id, raw] of Object.entries(saved || {})) {
      const s = raw && typeof raw === 'object' ? raw : {};
      this.gpus.set(Number(id), { ...freshGpu(), ...s, periods: Array.isArray(s.periods) ? [...s.periods] : [] });
    }
  }

  static fromJSON(saved) {
    return new IdleHistory(saved);
  }

  update(gpus, now = Date.now()) {
    for (const { id, utilization } of gpus) {
      if (!this.gpus.has(id)) this.gpus.set(id, freshGpu());
      const s = this.gpus.get(id);

      if (s.lastSampleAt !== null && now - s.lastSampleAt > GAP_MS) {
        if (s.openStart !== null) s.periods.push({ start: s.openStart, end: s.lastSampleAt });
        s.idleSince = s.busySince = s.openStart = null;
      }

      if (utilization < 1) {
        s.idleSince ??= now;
        s.busySince = null;
      } else {
        s.busySince ??= now;
        s.idleSince = null;
      }

      if (s.openStart === null && s.idleSince !== null && now - s.idleSince > MIN_IDLE_MS) {
        s.openStart = s.idleSince;
      }
      if (s.openStart !== null && s.busySince !== null && now - s.busySince > MIN_BUSY_MS) {
        s.periods.push({ start: s.openStart, end: s.busySince });
        s.openStart = null;
      }

      s.lastSampleAt = now;
      s.periods = s.periods.filter((p) => p.end >= now - WINDOW_MS);
    }
  }

  summary(id, now = Date.now()) {
    const s = this.gpus.get(id);
    if (!s) return { idleSince: null, lastIdleMs: null, idle30dMs: 0 };
    const from = now - WINDOW_MS;
    const overlap = (start, end) => Math.max(0, Math.min(end, now) - Math.max(start, from));
    let idle30dMs = s.periods.reduce((sum, p) => sum + overlap(p.start, p.end), 0);
    if (s.openStart !== null && s.lastSampleAt !== null) idle30dMs += overlap(s.openStart, s.lastSampleAt);
    const last = s.periods[s.periods.length - 1];
    return { idleSince: s.idleSince, lastIdleMs: last ? last.end - last.start : null, idle30dMs };
  }

  annotate(gpus, now = Date.now()) {
    return gpus.map((g) => ({ ...g, ...this.summary(g.id, now) }));
  }

  toJSON() {
    return Object.fromEntries(this.gpus);
  }
}

module.exports = { IdleHistory };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/idleHistory.test.js`
Expected: all 14 tests PASS.

- [ ] **Step 5: Swap the collector over and delete `IdleTracker`**

In `src/collector.js`:
- line 4: replace `const { IdleTracker } = require('./idleTracker');` with `const { IdleHistory } = require('./idleHistory');`
- line 52: replace `this.idle.set(server.name, new IdleTracker());` with `this.idle.set(server.name, new IdleHistory());` (Task 3 changes this to load saved state)
- line 106: replace `gpu: idle.annotate(gpus),` with `gpu: idle.annotate(gpus, now),`

Then:

```bash
git rm src/idleTracker.js test/idleTracker.test.js
```

The old "a GPU missing from a sample loses its idle state" behavior is intentionally replaced by the gap rule (covered by the gap tests above).

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: all tests PASS (the collector tests still pass; GPU entries now also carry `lastIdleMs` and `idle30dMs`).

- [ ] **Step 7: Commit**

```bash
git add src/idleHistory.js test/idleHistory.test.js src/collector.js
git commit -m "feat: record GPU idle periods with 10-minute hysteresis

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DW6DKVihcwiQtNwhKmuinD"
```

---

### Task 2: `idleStore` — atomic JSON load/save

**Files:**
- Create: `src/idleStore.js`
- Create: `test/idleStore.test.js`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (exported as `{ load, save }` from `src/idleStore.js`):
  - `load(filePath: string): { [serverName]: savedGpuStates }` — never throws; `{}` when missing, unreadable, or corrupt.
  - `save(filePath: string, servers: { [serverName]: savedGpuStates }): void` — creates the directory, writes `<file>.tmp` then renames over `filePath`; throws on I/O errors (the caller handles them).

- [ ] **Step 1: Write the failing tests**

Create `test/idleStore.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { load, save } = require('../src/idleStore');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'idle-store-')), 'nested', 'idle-history.json');

test('save then load round-trips, creates the directory, and leaves no temp file', () => {
  const file = tmpFile();
  const servers = { s: { 0: { idleSince: 1, busySince: null, openStart: null, lastSampleAt: 2, periods: [{ start: 0, end: 1 }] } } };
  save(file, servers);
  assert.deepStrictEqual(load(file), servers);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
  assert.ok(!fs.existsSync(`${file}.tmp`));
});

test('a missing file loads empty', () => {
  assert.deepStrictEqual(load(tmpFile()), {});
});

test('a corrupt or unrecognized file is backed up and loads empty', (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const content of ['not json', 'null', JSON.stringify({ version: 99, servers: {} }), JSON.stringify({ version: 1, servers: [] })]) {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    assert.deepStrictEqual(load(file), {});
    assert.ok(!fs.existsSync(file));
    const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('idle-history.json.corrupt-'));
    assert.strictEqual(backups.length, 1);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/idleStore.test.js`
Expected: FAIL with `Cannot find module '../src/idleStore'`.

- [ ] **Step 3: Implement `src/idleStore.js`**

```js
const fs = require('fs');
const path = require('path');

const VERSION = 1;

// Loads { [serverName]: gpuStates } from the idle history file. Never throws: a missing file is
// a fresh start, and an unreadable one is moved aside (not deleted) so the dashboard still starts.
function load(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`idle history: cannot read ${filePath} (${err.message}); starting empty`);
    return {};
  }
  try {
    const data = JSON.parse(raw);
    const servers = data && data.version === VERSION ? data.servers : null;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('unrecognized format');
    return servers;
  } catch (err) {
    const backup = `${filePath}.corrupt-${Date.now()}`;
    console.warn(`idle history: ${filePath} is unreadable (${err.message}); moved to ${backup}, starting empty`);
    try {
      fs.renameSync(filePath, backup);
    } catch {
      // best effort: the next save overwrites it anyway
    }
    return {};
  }
}

// Write-then-rename so a crash mid-write never leaves a half-written file behind.
function save(filePath, servers) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, servers }));
  fs.renameSync(tmp, filePath);
}

module.exports = { load, save };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/idleStore.test.js`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/idleStore.js test/idleStore.test.js
git commit -m "feat: add atomic JSON store for idle history

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DW6DKVihcwiQtNwhKmuinD"
```

---

### Task 3: Persist idle history in the collector

**Files:**
- Modify: `src/config.js` (new default + validation)
- Modify: `src/collector.js` (load at construction, periodic + stop save)
- Modify: `src/server.js:46-54` (signal handlers)
- Modify: `.gitignore` (add `data/`)
- Modify: `test/collector.test.js` (setup uses a temp file; new tests)

**Interfaces:**
- Consumes: `IdleHistory.fromJSON(saved)`, `history.toJSON()`, `history.annotate(gpus, now)` (Task 1); `load(filePath)`, `save(filePath, servers)` (Task 2).
- Produces:
  - config field `idleHistoryFile: string`, default `'data/idle-history.json'`
  - `collector.idleHistoryFile` — absolute path
  - `collector.saveIdleHistory(): void` — never throws
  - `collector.stop()` now saves before disconnecting

- [ ] **Step 1: Write the failing tests**

In `test/collector.test.js`, replace lines 1–22 (imports, `tick`, `setup`) with:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Collector } = require('../src/collector');
const { DEFAULTS } = require('../src/config');
const idleStore = require('../src/idleStore');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const tmpIdleFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'collector-')), 'idle-history.json');

// Fake SSH: the GPU query answers immediately, everything else (process queries) hangs
// until released, simulating a stuck `ps`/nvidia-smi on the remote.
function setup(idleHistoryFile = tmpIdleFile()) {
  const collector = new Collector({ ...DEFAULTS, idleHistoryFile, servers: [{ name: 's', host: 'h' }] });
  const pending = [];
  collector.ssh.set('s', {
    exec: (cmd) =>
      cmd === DEFAULTS.gpuQueryCommand
        ? Promise.resolve('0, GPU, 0, 1, 10, 30\n')
        : new Promise((resolve) => pending.push({ cmd, resolve })),
    disconnect: () => {},
  });
  const updates = [];
  collector.on('update', (s) => updates.push(s));
  return { collector, pending, updates, server: { name: 's', host: 'h' } };
}
```

Then append to the end of `test/collector.test.js`:

```js
test('GPU entries carry the idle summary', async () => {
  const { collector, updates, server } = setup();
  await collector._pollGpu(server);
  const gpu = updates[0].gpu[0];
  assert.strictEqual(typeof gpu.idleSince, 'number');
  assert.strictEqual(gpu.lastIdleMs, null);
  assert.strictEqual(gpu.idle30dMs, 0);
});

test('stop() saves idle history and a new collector resumes from it', async () => {
  const file = tmpIdleFile();
  const first = setup(file);
  await first.collector._pollGpu(first.server);
  first.collector.stop();

  const saved = idleStore.load(file);
  assert.strictEqual(typeof saved.s['0'].idleSince, 'number');

  const second = setup(file);
  await second.collector._pollGpu(second.server);
  assert.strictEqual(second.updates[0].gpu[0].idleSince, saved.s['0'].idleSince);
});

test('a failing save is logged and does not throw', (t) => {
  t.mock.method(console, 'warn', () => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-'));
  const blocker = path.join(dir, 'not-a-dir');
  fs.writeFileSync(blocker, '');
  const { collector } = setup(path.join(blocker, 'idle-history.json'));
  assert.doesNotThrow(() => collector.saveIdleHistory());
  assert.ok(console.warn.mock.calls.length > 0);
});

test('loadConfig rejects a non-string idleHistoryFile', () => {
  const { loadConfig } = require('../src/config');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ idleHistoryFile: 42 }));
  assert.throws(() => loadConfig(file), /idleHistoryFile/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/collector.test.js`
Expected: FAIL — `saveIdleHistory is not a function`, nothing written by `stop()`, and `loadConfig` does not throw for `idleHistoryFile: 42`.

- [ ] **Step 3: Add the config default and validation**

In `src/config.js`, after the `userAvatars: {},` default add:

```js
  // Where per-GPU idle history is persisted (relative to the repo root, or absolute).
  idleHistoryFile: 'data/idle-history.json',
```

and before `return config;` in `loadConfig` add:

```js
  if (typeof config.idleHistoryFile !== 'string' || !config.idleHistoryFile) {
    throw new Error('config.idleHistoryFile must be a non-empty file path');
  }
```

- [ ] **Step 4: Load and save in the collector**

In `src/collector.js`:

At the top, add after `const EventEmitter = require('events');`:

```js
const path = require('path');
```

and after the `IdleHistory` import:

```js
const idleStore = require('./idleStore');
```

Below `shellQuote`, add:

```js
const IDLE_SAVE_INTERVAL_MS = 60_000;
```

In the constructor, before the `for (const server of config.servers)` loop add:

```js
    this.idleHistoryFile = path.resolve(__dirname, '..', config.idleHistoryFile);
    const savedIdle = idleStore.load(this.idleHistoryFile);
```

and inside the loop replace `this.idle.set(server.name, new IdleHistory());` with:

```js
      this.idle.set(server.name, IdleHistory.fromJSON(savedIdle[server.name]));
```

At the end of `start()` (after the `for` loop) add:

```js
    this.timers.push(setInterval(() => this.saveIdleHistory(), IDLE_SAVE_INTERVAL_MS));
```

Replace `stop()` with:

```js
  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.saveIdleHistory();
    for (const ssh of this.ssh.values()) ssh.disconnect();
  }

  // Never throws: a failed save is logged and retried on the next interval. Servers no longer
  // in config are dropped from the file (history is keyed by server name).
  saveIdleHistory() {
    const servers = {};
    for (const [name, history] of this.idle) servers[name] = history.toJSON();
    try {
      idleStore.save(this.idleHistoryFile, servers);
    } catch (err) {
      console.warn(`idle history: saving ${this.idleHistoryFile} failed (${err.message}); will retry`);
    }
  }
```

- [ ] **Step 5: Save on shutdown signals**

In `src/server.js`, replace the `if (require.main === module) {` block with:

```js
if (require.main === module) {
  collector.start();
  // systemd stops/restarts send SIGTERM; save idle history before exiting so nothing is lost.
  const shutdown = () => {
    collector.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  app.listen(config.port, () => {
    console.log(`nvtop-tracker listening on http://localhost:${config.port}`);
    if (config.servers.length === 0) {
      console.log('No servers configured. Copy config.example.json to config.json and add your servers.');
    }
  });
}
```

- [ ] **Step 6: Ignore the data directory**

Append to `.gitignore`:

```
data/
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 8: Verify the shutdown save manually**

Run `npm start`, wait ~10 s, press Ctrl-C.
Expected: `data/idle-history.json` exists and contains `"version":1` and an entry per configured server. Run `npm start` again; idle timers on the cards continue from their previous values instead of restarting at 0.

- [ ] **Step 9: Commit**

```bash
git add src/config.js src/collector.js src/server.js .gitignore test/collector.test.js
git commit -m "feat: persist GPU idle history across restarts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DW6DKVihcwiQtNwhKmuinD"
```

---

### Task 4: "Idle history" card and docs

**Files:**
- Modify: `public/app.js:67-87` (shared duration formatter), `public/app.js:154-159` (render the card)
- Modify: `public/style.css` (table styles)
- Modify: `README.md`, `config.example.json`

**Interfaces:**
- Consumes: each `state.gpu[i]` carries `lastIdleMs: number|null` and `idle30dMs: number` (Task 1 via Task 3).
- Produces: `fmtDuration(ms)` and `renderIdleHistoryCard(gpus)` in `public/app.js`.

- [ ] **Step 1: Extract a shared duration formatter**

In `public/app.js`, replace `idleLabel` (lines 71–77) with:

```js
// hh:mm:ss with unbounded hours (e.g. 212:40:11).
function fmtDuration(ms) {
  const total = Math.floor(ms / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

// Idle time is measured on the server's clock (state.timestamp - idleSince) and then
// advanced by local elapsed time since the update arrived, so browser clock skew doesn't matter.
function idleLabel(el) {
  const idleMs = Number(el.dataset.idleMs) + (Date.now() - Number(el.dataset.receivedAt));
  if (el.dataset.idleMs === '' || idleMs < IDLE_GRACE_MS) return { text: 'in use', idle: false };
  return { text: fmtDuration(idleMs), idle: true };
}
```

(Delete the original two-line comment above `idleLabel` so it isn't duplicated.)

- [ ] **Step 2: Render the card**

Replace `renderGpuGraphsBody` with:

```js
function renderIdleHistoryCard(gpus) {
  const rows = gpus
    .map(
      (g) => `
        <tr>
          <td>GPU ${g.id}</td>
          <td>${g.lastIdleMs == null ? '—' : fmtDuration(g.lastIdleMs)}</td>
          <td>${fmtDuration(g.idle30dMs || 0)}</td>
        </tr>`
    )
    .join('');
  return `
    <div class="gpu-graph-card">
      <div class="gpu-graph-title">Idle history</div>
      <table class="idle-history">
        <thead><tr><th>GPU</th><th>Last idle</th><th>Idle (30d)</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderGpuGraphsBody(state) {
  if (!state.gpu.length) return '<div class="empty">No GPU data</div>';
  return `<div class="gpu-graphs-grid">${state.gpu
    .map((g) => renderGpuGraphCard(g, (state.historyByGpu && state.historyByGpu[g.id]) || [], state))
    .join('')}${renderIdleHistoryCard(state.gpu)}</div>`;
}
```

- [ ] **Step 3: Style the table**

Append to `public/style.css` after the `.gpu-graph-card svg` rule:

```css
.idle-history { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
.idle-history th { text-align: left; color: #888; font-weight: normal; padding: 2px 4px; }
.idle-history td { color: #ccc; padding: 2px 4px; }
```

- [ ] **Step 4: Check syntax and tests**

Run: `node --check public/app.js && npm test`
Expected: no syntax error; all tests PASS.

- [ ] **Step 5: Verify in the browser**

Run `npm start`, open `http://localhost:3000`.
Expected:
- The last card in the GPU Graphs block is "Idle history", one row per GPU, columns GPU · Last idle · Idle (30d).
- Fresh data shows `—` for last idle and `00:00:00`, growing for GPUs idle more than 10 minutes.
- The live timer, "in use" tag and avatars on each GPU card are unchanged.

- [ ] **Step 6: Document it**

In `config.example.json`, after the `"userAvatars"` line add (keep the JSON valid — add a comma to the previous line):

```json
  "idleHistoryFile": "data/idle-history.json"
```

In `README.md`, under **Features**, after the "Idle timer & owners" bullet add:

```markdown
- **Idle history**: an extra card in the GPU graphs shows, per GPU, how long
  it was idle before it was last taken into use and its total idle time over
  the past 30 days. Idle periods only count after 10 minutes, and short
  bursts of activity (10 minutes or less) don't end them. The data is saved
  to `data/idle-history.json`, so it survives restarts.
```

and add a row to the configuration table, after the `userAvatars` row:

```markdown
| `idleHistoryFile` | `data/idle-history.json` | Where idle history is saved (relative to the repo root, or absolute). Written every minute and on shutdown. The `data/` folder is gitignored. |
```

Run: `node -e 'JSON.parse(require("fs").readFileSync("config.example.json"))'`
Expected: no output (valid JSON).

- [ ] **Step 7: Commit**

```bash
git add public/app.js public/style.css README.md config.example.json
git commit -m "feat: show per-GPU last idle and 30-day idle total

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DW6DKVihcwiQtNwhKmuinD"
```
