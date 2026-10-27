# Idle alerts and Teams notifications — design

**Date:** 2026-10-23
**Status:** draft for review

## Why

The whole development team shares a few GPU servers. When a GPU (or MIG partition) sits idle
for hours, nobody notices unless someone has the dashboard open. The user wants the idle time
to stand out on the dashboard, and wants the team's Microsoft Teams channel to receive an
**informational** message when GPUs have been idle for a long time and when a server becomes
unreachable. The messages are for awareness only; nobody is expected to act on a button.

## Goals

1. **Dashboard escalation** on each GPU graph card (whole GPUs and MIG partitions alike), driven
   by the existing live idle timer:
   - idle **≥ 4 h** → the card background turns **light yellow**;
   - idle **≥ 12 h** → the card background turns **light red**, and the status pill turns
     **red with a "!"** in front of the `hh:mm:ss` time.
2. **Idle notifications** to a Teams channel:
   - when any GPU crosses **12 h** idle, send a message;
   - while it stays idle, send again each time it crosses a new **multiple of 12 h** (24 h, 36 h, …);
   - every message lists **all** GPUs (across all servers) currently idle ≥ 12 h, with their idle
     time — so several GPUs are always reported together in one message.
3. **Unreachable notifications**:
   - a server unreachable for **5 minutes in a row** → send a message;
   - while it stays unreachable, send a **reminder every 1 hour**;
   - when it comes back (after a notice was sent) → send a short recovery message with the
     total downtime.

## Non-goals

- Any action buttons, acknowledgements, muting, or per-user mentions in Teams.
- Other channels (email, Slack, …).
- Configurable thresholds — 4 h / 12 h / 12 h step / 5 min / 1 h are fixed constants.
- Notifying about non-idle states (high temperature, disk alerts, …).

## Anti-goals

- **Duplicate messages**: a service restart (e.g. `deploy/update.sh`) must not re-send a
  milestone or a down-notice that was already sent.
- **False alarms**: GPUs whose utilization is unknown (`null`, e.g. MIG without DCGM) or whose
  server is offline must never be reported or coloured as idle; a short SSH blip (< 5 min) must
  not produce an unreachable message.
- **Leaking the webhook URL**: it is a secret (anyone who has it can post in the channel). It
  lives only in `config.json` (gitignored), is never committed, logged, or sent to the browser.
- A notification failure (Teams down, bad URL) must never affect polling or the dashboard.

## Delivery: Microsoft Teams Workflows

Chosen together with the user (the Webhook Bot app has no documented payload format):

- The user created a Teams **Workflows** flow from the template
  **"Send webhook alerts to a channel"** on the team channel (trigger
  "When a Teams webhook request is received", access "Anyone", step "Send each adaptive card").
- The tracker POSTs JSON to the flow's URL with `Content-Type: application/json` in this envelope
  (verified working on 2026-10-23):
  ```json
  { "type": "message",
    "attachments": [{ "contentType": "application/vnd.microsoft.card.adaptive",
                      "content": { "type": "AdaptiveCard", "version": "1.4", "body": [ ... ] } }] }
  ```
- The flow answers `202` with no body on success. Message size limit: 28 KB.
- Config: new field `teamsWebhookUrl` (string, default `""`). Empty → notifications disabled
  (the dashboard escalation still works). A value containing a backslash must be rejected at
  startup with a clear error — zsh's URL-paste magic inserts `\` before `?`, `=` and `&`, which
  the user hit while testing, and the Workflows endpoint then answers `ApiVersionInvalid`.

## Message design (approved by the user on 2026-10-23)

### Idle message

Adaptive Card 1.4:

- Title `TextBlock`: `⚠️ GPUs ociosas há mais de 12h` — `weight: Bolder`, `size: Medium`,
  `color: Attention`, `wrap: true`.
- A table built from `ColumnSet`s (not `FactSet` — its narrow title column wrapped
  "GPU 7 - 2" onto two lines):
  - header row: `Servidor` (width `stretch`), `GPU` (`auto`), `Ociosa há` (`auto`, right-aligned),
    all `weight: Bolder`, `isSubtle: true`;
  - one row per GPU (first data row has `separator: true`), spacing `Small`: server name
    (`wrap: true`), GPU label (`"GPU 3"`, `"GPU 7 - 2"`), idle time `hh:mm:ss` with unbounded
    hours (same format as the dashboard), right-aligned, `fontType: Monospace`.
- Rows ordered by idle time, longest first.

The verified test card JSON is the reference for structure and styling.

### Unreachable messages *(controller's call on wording/structure, same card style)*

- Down / reminder: title `🔴 <server> inacessível` (`color: Attention`), then a line
  `Sem resposta desde <dd/mm HH:MM> (há <duration>)` and, subtle, `Último erro: <error message>`.
  Reminders use the same card.
- Recovery: title `✅ <server> voltou` (`color: Good`), line `Ficou inacessível por <duration>`.
- `<duration>` is human-readable (`2h13min`, `45min`); times use the tracker host's local time.

## Behavior

### Idle time

The idle time of a GPU entry is the existing live idle timer: `now - idleSince` from
`IdleHistory` (< 1 % utilization, reset by any activity). Entries with unknown utilization,
or on a server whose **GPU poll** is currently failing (`downSince` set — see below), have no
idle time for these purposes *(controller's call: the notifier must not use `state.connected`,
which a successful disk poll can set back to `true` during a GPU-only outage)*. The browser
keeps its existing `state.connected` check for the `offline` pill.

### Dashboard

- Escalation is computed in the browser from the same data the 1-second ticker already uses,
  so a card changes colour exactly when its timer crosses 4 h / 12 h, without waiting for a
  re-render.
- Colours must be subtle tints that keep text readable on the existing dark theme (the card is
  `#22262f` today); exact values are the builder's call, to be checked visually.
- `offline` and `n/a` / `MIG` states are never coloured.

### Idle notifications

- A notifier evaluates all servers once a minute *(controller's call; ≤ 1 min latency)*.
- For each entry key with an idle time, its milestone is `floor(idleMs / 12h)`. If the milestone
  is ≥ 1 and greater than the milestone last notified for that key **and the same `idleSince`**,
  a message is due.
- When one or more entries are due, send **one** message listing every entry currently idle
  ≥ 12 h (all servers), then record each listed entry's current milestone as notified.
- If an entry's `idleSince` changes (it became busy and idle again), its notified milestone
  starts over.
- *(Controller's call)* With no notifier state yet (first deploy, or the state was lost), GPUs
  already idle ≥ 12 h are reported in one catch-up message on the first evaluation. It is
  informational, and the team would want to know.

### Unreachable notifications

- A server is unreachable when its **GPU poll** keeps failing (SSH error). `downSince` is the time
  of the first failed GPU poll after the last success. The disk/status polls do not affect this.
- Down notice when `now - downSince ≥ 5 min` and none was sent for this outage; reminders every
  `1 h` after the last notice; recovery message on the first successful GPU poll after a notice.
  An outage shorter than 5 min produces no message at all.
- *(Controller's call)* Recovery is tracked as a persisted "recovery pending" marker (server,
  `downSince`, recovered-at) so a failed recovery POST is retried like any other message.
- *(Controller's call)* After a tracker restart, a persisted outage whose notice was already sent
  still gets its recovery message, with the duration measured from the saved `downSince` (the
  message reads "inacessível desde <dd/mm HH:MM>", so time the tracker itself was down is visible).
  A persisted outage with no notice sent is dropped silently.

### Persistence

- Notifier state (per entry: notified milestone and the `idleSince` it belongs to; per server:
  `downSince`, last notice time) is saved alongside the idle history — written on the existing
  60 s save and on shutdown — so restarts neither duplicate nor lose notifications.
- A sent message is recorded only after the POST succeeds; a failed POST is retried on the next
  evaluation (one minute later).

### Failure handling

- POSTs use a 10 s timeout. Non-2xx, network errors and timeouts are logged (without the URL)
  and retried on the next evaluation; nothing else is affected.

## Testing

- Notifier logic as pure functions/units with injected time and a fake sender: 12 h milestone,
  24 h re-send, batching of several GPUs (and across servers), reset when `idleSince` changes,
  unknown/offline entries ignored, restart (state round-trip) not re-sending, failed send retried.
- Unreachable: < 5 min no message; 5 min down notice; hourly reminders; recovery message only
  after a notice; disk-poll success during a GPU outage doesn't count as recovery.
- Card builders: produce the approved structure (`ColumnSet` rows, order, `hh:mm:ss`).
- Config: empty URL disables; URL with `\` rejected.
- Manual: dashboard colours checked in the browser (forcing idle times); one real message of
  each kind sent to the channel after the user agrees.

## Left to the builder

- Module boundaries (e.g. a pure `notifier` + a small `teams` sender), the exact colour values,
  and where the notifier hooks into the collector.
- Whether notifier state shares the idle-history file or sits next to it, as long as it uses the
  same atomic store and the same save cadence.
