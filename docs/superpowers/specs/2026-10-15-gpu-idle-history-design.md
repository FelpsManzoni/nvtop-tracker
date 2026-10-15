# GPU idle history — design

**Date:** 2026-10-15
**Status:** approved in conversation, pending written-spec review

## Goal

Keep GPU idle tracking across server restarts (e.g. every `deploy/update.sh` run), and show,
per GPU, how long it sat idle before it was last taken into use and how much idle time it
accumulated in the past 30 days. Short blips of activity must not overwrite a long idle period.

Note: a browser refresh (F5) already keeps the live idle timer, because `idleSince` lives on
the server. What resets it today is a server restart; persistence fixes that.

## Non-goals

- Changing the live idle timer / "in use" tag / avatars on each GPU card (behavior unchanged).
- Queryable history, charts over time, per-user attribution of idle time.
- Surviving a server rename in `config.json` (history is keyed by server `name`).

## Definitions

All thresholds are constants in `src/idleHistory.js`:

| Constant | Value | Meaning |
|---|---|---|
| `IDLE_THRESHOLD` | utilization < 1% | a sample counts as idle |
| `MIN_IDLE_MS` | 10 min | raw idle stretch needed to open a period |
| `MIN_BUSY_MS` | 10 min | continuous activity needed to close a period |
| `WINDOW_MS` | 30 days | rolling window for the total, and retention |
| `GAP_MS` | 5 min | longer without a sample for a GPU = unknown, break state |

Per GPU, the state is:

- `idleSince` — start of the current raw idle stretch (`null` while busy). Drives the live
  timer exactly as today: any sample ≥ 1% clears it.
- `busySince` — start of the current raw busy stretch (`null` while idle).
- `openStart` — start of the open idle period (`null` if none).
- `lastSampleAt` — timestamp of the last successful sample for this GPU.
- `periods` — closed periods `[{ start, end }]`, pruned to `WINDOW_MS`.

## Behavior

On each successful sample `(utilization, now)` for a GPU:

1. **Gap rule.** If `lastSampleAt` exists and `now - lastSampleAt > GAP_MS`: if `openStart`
   is set, close the period as `{ start: openStart, end: lastSampleAt }`; then reset
   `idleSince`, `busySince`, `openStart` to `null`. (Covers service downtime, SSH outages,
   and a GPU that disappears and reappears.)
2. **Raw state.** Idle sample: `idleSince ??= now`, `busySince = null`. Busy sample:
   `busySince ??= now`, `idleSince = null`.
3. **Open.** If `openStart` is null and `idleSince` is set and `now - idleSince > MIN_IDLE_MS`:
   `openStart = idleSince` (the period includes its first 10 minutes).
4. **Close.** If `openStart` is set and `busySince` is set and `now - busySince > MIN_BUSY_MS`:
   push `{ start: openStart, end: busySince }`, `openStart = null`. Busy stretches of
   `MIN_BUSY_MS` or less are absorbed into the open period.
5. `lastSampleAt = now`; drop periods with `end < now - WINDOW_MS`.

GPUs absent from a sample are not touched; the gap rule handles them when they return.

**Summary** for a GPU at `now`:

- `idleSince` — as above (sent to the live timer).
- `lastIdleMs` — `end - start` of the most recent closed period, or `null`.
- `idle30dMs` — sum over closed periods plus the open period (`openStart..now`) of their
  overlap with `[now - WINDOW_MS, now]`.

Worked example: idle 12h, busy 1m, idle 1h30m, busy 3h → one period of 13h31m, closed when
the 3h stretch passes 10 minutes; `lastIdleMs` = 13:31:00.

## Persistence

- One JSON file, default `data/idle-history.json`, configurable via `idleHistoryFile`
  (relative to the repo root, or absolute). `data/` is gitignored.
- Shape: `{ "version": 1, "servers": { "<server name>": { "<gpu id>": <gpu state> } } }`.
- Written every 60 s by the collector and on `collector.stop()`. `server.js` handles
  `SIGTERM`/`SIGINT` by stopping the collector (final save) and exiting, so systemd
  restarts lose nothing. Worst case (crash / power loss): ~60 s of data.
- Writes are atomic: write `<file>.tmp`, then `rename` over the target. The directory is
  created if missing.
- Load: missing file → empty state. Unreadable/invalid JSON or wrong `version` → log a
  warning, rename to `<file>.corrupt-<timestamp>`, start empty. Startup never fails because
  of this file. A save error is logged and retried on the next interval.

A normal restart takes seconds (< `GAP_MS`), so timers and open periods continue; after
longer downtime the gap rule closes open periods at the last saved sample.

## Components

- `src/idleHistory.js` (new, replaces `src/idleTracker.js`): `IdleHistory` class, one per
  server, pure (no I/O). `update(gpus, now)`, `summary(gpuId, now)`, `toJSON()`,
  `static fromJSON(obj)`. The existing `IdleTracker` tests are migrated.
- `src/idleStore.js` (new): `load(filePath)` → object; `save(filePath, data)`. Atomic write,
  corrupt-file backup. No other logic.
- `src/collector.js`: builds each server's `IdleHistory` from the store at construction,
  saves every 60 s (timer cleared in `stop()`), saves in `stop()`, and annotates each GPU
  entry with `idleSince`, `lastIdleMs`, `idle30dMs`.
- `src/server.js`: `SIGTERM`/`SIGINT` handlers → `collector.stop()` → `process.exit(0)`.
- `src/config.js`: `idleHistoryFile: 'data/idle-history.json'` default.
- `public/app.js` / `style.css`: one extra card at the end of the GPU graph grid, titled
  "Idle history": a table with columns GPU · Last idle · Idle (30d), values in `hh:mm:ss`
  (hours unbounded, e.g. `212:40:11`), `—` when `lastIdleMs` is null. Refreshes with each
  SSE update; no per-second ticking.

## Testing

- `test/idleHistory.test.js`: the worked example (13:31:00); idle ≤ 10 min never recorded;
  9-minute busy blip does not close, 11-minute busy stretch does; period end = start of
  sustained activity; live `idleSince` still resets on any activity; 30-day partial overlap
  and pruning; open period counted up to now; 3-minute gap continues, 6-minute gap closes at
  last sample and resets; `toJSON`/`fromJSON` round trip.
- `test/idleStore.test.js`: save→load round trip; missing file → empty; corrupt file →
  backed up and empty; directory created on save.
- `test/collector.test.js`: GPU entries carry the summary fields; `stop()` writes the file.
- Manual: run against real servers; restart the service and confirm timers continue.
