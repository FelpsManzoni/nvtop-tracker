# Prometheus data source (no SSH) — design

**Date:** 2026-10-28
**Status:** reviewed; open questions decided on 2026-10-28 (see *Decisions*)

Names in this document are placeholders: **GPU server** is the multi-GPU host that also runs the
team's Prometheus and the dashboard, **Jetson** is a Jetson-class device with unified memory, and
**old dashboard host** is the machine that runs the current SSH-based tracker.

## Why

The tracker reads every value by running commands over SSH every 2 s, with a private key that
logs into each monitored server as a regular user. Whoever holds that key has a shell on every GPU
server, and the dashboard host must reach every server. The team wants the dashboard to read from
Prometheus instead.

Another team already runs a monitoring stack (dcgm-exporter, Prometheus, Grafana) on the GPU
server, but it cannot replace SSH as is:

- its dcgm-exporter stopped exporting utilization and memory for a GPU once MIG was enabled on it,
  and it exports no per-partition activity at all;
- nothing in it reports GPU processes and their owners, container names, the biggest folder of a
  mount, or anything about the Jetson;
- its GPU values refresh every 30 s; the tracker refreshes every 2 s.

Changing that stack is not an option, so the team runs its **own** stack on the GPU server, on its
own ports, covering everything the dashboard shows today.

## Goals

1. The dashboard reads all its data from the team's Prometheus over HTTP. No SSH, no keys, no
   commands run by the dashboard.
2. Feature parity with today's dashboard: per-GPU utilization, memory and temperature (2 s refresh,
   5-minute graphs); MIG partitions as their own entries with utilization; idle timer, idle history
   and Teams alerts; process owners/avatars and the GPU Processes list; running containers; disk
   usage with the biggest-folder scan; per-server online/offline.
3. MIG stays correct when partitions exist, change, or cannot be measured (see *MIG*).
4. The Jetson shows its GPU (today the GPU is dropped because its memory reads `[N/A]`).
5. Everything runs in Docker: the stack and the dashboard on the GPU server, a small agent on the
   Jetson.
6. Idle history and notifier state carry over from the current deployment: no idle period is lost
   and no Teams message is repeated at cut-over.

## Non-goals

- Changing anything in the other team's monitoring stack.
- Grafana dashboards for the new metrics (possible later; the data will be in Prometheus).
- More servers (later: run the exporter there and add one scrape target or agent).
- Authentication on the dashboard itself; changes to idle or alert rules.
- Shrinking the SSE payload (~140 KB every 2 s for an eight-GPU server today); separate change.
- The Docker images list (collected today, never shown) is dropped.

## Anti-goals (failure even if it "works")

- **Unknown shown as idle.** A GPU or partition whose utilization is missing (exporter down, DCGM
  down, MIG being reconfigured) must be `n/a`, never 0 %, so it never starts an idle timer or a
  Teams idle alert.
- **Stale shown as live.** Prometheus keeps returning a series' last value for 5 minutes after it
  stops being updated; the dashboard must not present such a value as current.
- **A Prometheus outage reported as every server being down**, or idle alerts computed from data
  that stopped updating.
- **Duplicate Teams messages** during the parallel run or at cut-over.
- **The exporter becoming a new way in.** It must not be reachable from the network, must not be
  able to start or stop containers, and runs with the least privileges that let it read what it
  reports.
- **Deployment details in the repository.** The repository is public: host names, addresses,
  users, disk layouts and credentials live only in generated, gitignored files on each host.

## Facts gathered (read-only, 2026-10-28)

**The other team's stack on the GPU server:**

- dcgm-exporter with its own embedded DCGM and the default counters; Prometheus scraping every
  15 s; Grafana; a node_exporter and Docker daemon metrics (container counts only, no names).
- After MIG was enabled on one GPU, that GPU's utilization and memory series stopped; only
  temperature/power/clock series remained for it. No `DCGM_FI_PROF_*` metric is exported.
- Values refresh every 30 s (the energy counter repeats on every other 15 s scrape).

**GPU server:**

- The host runs the DCGM host engine as a service, listening on `127.0.0.1:5555`. The tracker's
  `dcgmi dmon -e 1001` already reads MIG partition activity from it.
- Docker with the NVIDIA container runtime.
- Users come from `/etc/passwd`, so a read-only `/etc/passwd` mount is enough to resolve process
  owners inside a container.
- The deploying developer is in the `docker` group; the ports this design uses are free.
- NTP synchronized.
- The GPU server **cannot** open connections to the Jetson.

**Jetson:**

- `nvidia-smi --query-gpu=...` prints `0, NVIDIA <model>, 0, [N/A], [N/A], 45`: utilization and
  temperature are numbers, memory is `[N/A]` (unified memory). `parseGpuCsv` drops the line, so the
  Jetson shows "No GPU data" while its GPU Processes block lists a running process.
- Docker with the NVIDIA container runtime; NTP synchronized.
- Only `/` is mounted, which the tracker always excludes, so no disk is shown today.
- The Jetson **can** reach the GPU server.

## Architecture

```
 GPU server: deploy/hub                                          Jetson: deploy/remote
 ┌──────────────────────────────────────────────────────┐       ┌───────────────────────────┐
 │ nvtop-exporter   127.0.0.1:19101                     │       │ nvtop-exporter            │
 │   nvidia-smi, dcgmi, ps, df, du, containers (proxy)  │       │   127.0.0.1:19101         │
 │        ▲ scrape every 2 s                            │       │   nvidia-smi, meminfo,    │
 │ Prometheus  :19090                                   │       │   ps, containers (proxy)  │
 │   basic auth, remote-write receiver, 30 d retention  │◄──────┤        ▲ scrape every 2 s │
 │        ▲ HTTP API every 2 s                          │remote │ Prometheus (agent mode)   │
 │ nvtop-tracker dashboard  :13000  ── SSE ──► browsers │write  └───────────────────────────┘
 └──────────────────────────────────────────────────────┘
```

### Why our own exporter instead of NVIDIA's dcgm-exporter

The exporter is the tracker's current collector running locally instead of over SSH: same
commands, same parsers (`src/parsers.js`, `src/mig.js`), same poll cadences.

- MIG handling already works and is covered by tests (topology from `nvidia-smi -q -x`, activity
  from DCGM field 1001, generation fencing of stale polls). The other team's dcgm-exporter, started
  before MIG was enabled, reported nothing usable for the MIG GPU afterwards; adopting one would
  first require proving that it picks up partition changes without a restart.
- Utilization keeps today's meaning (`nvidia-smi utilization.gpu` for whole GPUs, DCGM 1001 for
  partitions), which the idle rules (< 1 %) were built on.
- One exporter covers both hosts; the Jetson has no DCGM.
- Processes with owners, container names and `du` need custom code anyway.

### nvtop-exporter

- Node, in this repo, reusing the parsers; runs the commands locally instead of over SSH.
- Polls on its own timers and serves the latest snapshot on `/metrics`; a scrape never runs a
  command. Cadences as today: GPU every 2 s; processes and `ps` ride the GPU poll; the MIG poll
  runs while a GPU reports `[N/A]` utilization; disk (`df`, `du`) and containers every 5 min.
  Every poll has at most one run in flight, the GPU poll included (today it can pile up when a
  server hangs).
- Listens on `127.0.0.1:19101` only.
- Host access on the GPU server: `nvidia` runtime with `NVIDIA_DRIVER_CAPABILITIES=utility`;
  `pid: host` so `nvidia-smi` and `ps` see host processes; host network so `dcgmi` reaches
  `127.0.0.1:5555`; `/etc/passwd` read-only; each data disk bind-mounted read-only at its own path
  so `df` and `du` report host paths; containers listed through a socket proxy that only allows
  listing. `cap_drop: [ALL]` plus `DAC_READ_SEARCH` (so `du` can read every directory),
  `no-new-privileges`, read-only root filesystem.
- On the Jetson: no DCGM; when `nvidia-smi` reports memory as `[N/A]`, memory comes from
  `/proc/meminfo` (see *Jetson GPU memory*).

### Metrics

Entries are identified exactly as the dashboard identifies them today: `key` (`"3"`, `"7-2"`) and
`label` (`"GPU 7 - 2"`). Prometheus adds a `server` label (e.g. `"GPU Server 1"`) from its scrape
config or the agent's; the exporter does not know the server name.

| Metric | Labels | Notes |
|---|---|---|
| `nvtop_gpu_info` = 1 | `key, label, gpu, name, mig, gpu_instance_id, unified_memory` | One per entry (whole GPU or partition), present even when nothing else is known. |
| `nvtop_gpu_utilization_percent` | `key` | **Absent when unknown.** Partitions: DCGM 1001 × 100. |
| `nvtop_gpu_memory_used_mib`, `nvtop_gpu_memory_total_mib` | `key` | Absent when unknown. |
| `nvtop_gpu_temperature_celsius` | `key` | Partitions repeat the parent GPU's. |
| `nvtop_gpu_process_memory_mib` | `key, gpu, pid, user, process, command` | Owner and command from `ps`; command truncated to 500 chars. |
| `nvtop_container_created_timestamp_seconds` | `name, status` | Running containers, newest first; `status` is the Engine API's text ("Up 3 hours (healthy)"), the same `docker ps` shows. |
| `nvtop_disk_size_kib`, `nvtop_disk_used_kib`, `nvtop_disk_usage_percent` | `mountpoint, filesystem` | `df -kPT`, same filters as today. |
| `nvtop_disk_top_folder_kib` | `mountpoint, path` | Best-effort `du`, as today. |
| `nvtop_poll_success` (0/1), `nvtop_poll_last_success_timestamp_seconds` | `poll` (`gpu`, `processes`, `mig`, `disk`, `containers`) | Freshness and failure state. |

"Absent means unknown" is the rule every metric follows.

### Dashboard

- The SSH collector is replaced by a Prometheus source: every `gpuPollIntervalMs` (2 s) it queries
  the team Prometheus and builds the same per-server state as today (`gpu`, `disk`, `docker`,
  `gpuProcesses`, `trends`, `historyByGpu`, `connected`, `error`), so the browser code barely
  changes. `IdleHistory`, `Notifier`, the Teams cards and the avatar mapping stay as they are.
- On startup it fills the 5-minute graphs with a range query, so a restart no longer starts with
  empty graphs.
- Servers are the `servers` entries in `config.json`; each `name` equals a `server` label.

## Behavior

### MIG

- The exporter decides which entries exist (one whole GPU, or one entry per partition) exactly as
  the tracker does today; the dashboard displays what `nvtop_gpu_info` lists.
- Partition utilization comes from DCGM and is published only while a fresh reading exists
  (today's rule: older than 3 × the GPU poll interval means unknown). DCGM down, a partition DCGM
  does not know, or a reconfiguration in progress → no utilization series → `n/a`, the `MIG` tag,
  no idle timer, no idle alert.
- Partition memory comes from the `nvidia-smi -q -x` XML, so it shows even when DCGM is down.
- MIG can be enabled on any GPU at any time (one GPU left MIG mode during the spikes, and it may
  come back on any GPU). In a container, the XML may show MIG enabled but list no partitions (they
  need the MIG monitor capability, i.e. `CAP_SYS_ADMIN`). When the XML hides the partitions or
  cannot be read, the layout comes from DCGM (`dcgmi discovery`, host engine on the host) and the
  partition memory from DCGM fields 250/252, read in the same `dcgmi dmon` as the activity.
  Processes of such a GPU then stay listed on the whole GPU, since only the XML maps a process to
  its partition.
- When partitions are created or destroyed, the next MIG poll publishes the new set of entries and
  the series of removed ones stop. Keys stay `"<gpu>-<MIG device index + 1>"`, as today, so idle
  history continues for partitions that keep their index.
- A GPU leaving MIG mode goes back to a single entry with its `nvidia-smi` utilization.

### Freshness and "unreachable"

- A server's GPU data is current while
  `time() - nvtop_poll_last_success_timestamp_seconds{poll="gpu"}` is at most ~10 s. That covers
  host down, exporter down, a hung `nvidia-smi`, the Jetson's agent down, and the network between
  the Jetson and the GPU server. Both hosts are NTP-synchronized; the timestamp comes from each
  exporter's clock.
- Not current → the server shows offline and the notifier gets `observe(ok: false)` with an error
  such as `sem dados novos há 2min`. Down notice, hourly reminders and recovery work exactly as
  today (5 min, 1 h).
- Only GPU freshness decides online/offline. A stale disk, container or process poll keeps or
  empties its own block, as today.

### Prometheus unreachable

- A failing query (Prometheus down, bad credentials) marks no server as down and feeds no idle
  evaluation: the dashboard shows the last data as stale with the error, and the notifier computes
  nothing from it.
- Prometheus itself is tracked like a server named `Prometheus (nvtop)`: down for 5 min → one
  down card, hourly reminders, a recovery card, reusing the existing cards.

### Jetson GPU memory

The Jetson's GPU shares system memory with the CPU and `nvidia-smi` reports no memory. Total =
`MemTotal`, used = `MemTotal − MemAvailable` from `/proc/meminfo`, with `unified_memory="true"` so
the card can say so. When no value is available the GPU is still shown with memory `n/a`:
`parseGpuCsv` keeps lines with unknown memory, as it already does for unknown utilization.

### Idle history and notifier continuity

Server names and entry keys do not change, so copying `data/idle-history.json` and
`data/notifier-state.json` from the old dashboard host into the new dashboard's data folder at
cut-over continues both. A gap longer than 5 minutes between the last old sample and the first new
one closes open idle periods, as any outage does today.

## Security

- No SSH keys anywhere; the dashboard only needs HTTP to Prometheus.
- Exporters listen on `127.0.0.1` only; their own Prometheus is the only client.
- Prometheus on `:19090` requires basic auth (`--web.config.file`): it must accept remote writes
  from the Jetson, and its API exposes the full command lines of GPU processes. Credentials live in
  a gitignored env file on each host and are used by the dashboard and by the Jetson's agent.
- Containers are listed through a socket proxy (`wollomatic/socket-proxy`) that allows only
  `GET /containers/json` and listens on a Unix socket in a volume shared with the exporter; the
  exporter never gets the Docker socket. Not a TCP port: any local user of the host could reach
  one, even on `127.0.0.1`, and a proxy allowing `GET /containers/*` would also hand out
  `inspect` (environment variables, i.e. secrets).
- The dashboard stays unauthenticated on `:13000` and exposes what it exposes today, process
  command lines included.

## Configuration

Dashboard `config.json`:

- New: `prometheusUrl` (e.g. `http://127.0.0.1:19090`). Prometheus credentials come from
  environment variables, never from the repo.
- `servers`: `[{ "name": "GPU Server 1" }, { "name": "GPU Server 2" }]`; `name` matches the
  `server` label.
- Kept: `port`, `gpuPollIntervalMs`, `gpuHistoryMinutes`, `diskStorageAlertThreshold`,
  `userAvatars`, `idleHistoryFile`, `teamsWebhookUrl`.
- Moved to the exporter: the `*QueryCommand` fields, `diskTopFolderMountPrefixes`,
  `duTimeoutSeconds`, `diskPollIntervalMs`. Removed: per-server `host`/`user`/`port`,
  `sshRetryMaxAttempts`, `sshRetryDelayMs`.

Exporter: today's command defaults, plus listen address, watched mounts (`diskMountPrefixes`:
`null` for every real mount, a list to restrict, `[]` for none) and the memory fallback for
unified-memory GPUs.

Per-host values (server name, the GPU server's address, data disks, credentials, the host's DCGM
client) are passed to each deploy folder's `init.sh`, which writes them into gitignored files:
`.env`, `prometheus.yml` or `agent.yml`, `exporter.config.json`, `compose.override.yaml`. The
committed compose files and examples hold no deployment details.

## Rollout

1. Validation spikes (below) on both hosts with throwaway containers.
2. Deploy the hub stack on the GPU server and the remote stack on the Jetson next to the running
   old dashboard, with `teamsWebhookUrl` empty and a copy of the old host's `data/` so both boards
   start from the same idle history. Run the parity check (below): one 30-minute run right after
   deploy, then at least one run a day. The new board can also run earlier with plain `node`
   against the team Prometheus, before the Docker packaging exists.
3. Cut-over, only after parity runs with no unexpected mismatch, in one sitting: stop the old
   service, copy `data/` and `avatars/` again, set `teamsWebhookUrl`, restart the dashboard,
   announce the new URL.
4. Rollback: start the old service again with its data (copy `data/` back first if the new copy is
   newer).

## Parity check (Playwright)

Compares the new board with the old one while both run on live data. It lives in
`feat/prometheus` and is not part of `npm test`, since it needs both boards up.

- `playwright` (the library, pinned) as a dev dependency; run with
  `OLD_URL=http://old-dashboard-host:3000 NEW_URL=http://gpu-server-1:13000 npm run parity`
  from any machine that reaches both. Duration and round interval are options (default: 30 min, a
  round every 30 s; a single-round mode for quick checks).
- Each round opens both boards, selects each server in the sidebar, waits for a fresh update, and
  captures from both pages at nearly the same moment:
  - the state the page received (the `servers` map in `public/app.js`), and
  - the rendered DOM: GPU cards and their status pill, `MIG` / `n/a` tags, owner avatars, the
    Idle history table, GPU list, process, container and disk rows.
- The two boards sample at different instants, so values are compared with tolerances, and a
  mismatch counts only when it shows in **two consecutive rounds** (this also absorbs process
  churn). Containers and disks are polled every 5 minutes by both boards, out of phase, so theirs
  count only once they outlast a poll plus a minute:

| Item | Rule |
|---|---|
| Servers, online/offline | Equal |
| GPU entries (labels, order), `MIG` / `n/a` tags | Equal |
| Utilization | Same idle/busy class (< 1 %); value within ±10 points |
| Memory | Within ±2 % of total |
| Temperature | Within ±3 °C |
| Status pill | Same state (in use / idle / `n/a` / `MIG` / offline); idle time within ±10 s |
| Idle history (last idle, 30 d) | Within ±1 min |
| Owners per GPU | Same set |
| GPU processes | Same (GPU, pid, owner) set; command equal up to the new board's truncation |
| Containers | Same names |
| Disk | Same mountpoints; usage within ±1 point |

- Expected differences, reported but not counted: a unified-memory GPU exists only on the new
  board; the biggest folder may differ, since the new exporter reads every directory and the old
  one only what its SSH user could read.
- Output: a JSON report plus an HTML page with the mismatch table and side-by-side screenshots of
  each server per round, written to a local, gitignored folder. A run passes when no unexpected
  mismatch persists.

## Branches

- `feat/prometheus` (from `master`): the exporter, the dashboard's Prometheus source, removal of
  the SSH collection, tests, the parity check, this spec. Runs with plain `node` against any
  Prometheus.
- `feat/docker` (from `feat/prometheus`): Dockerfiles for the dashboard and the exporter; the hub
  compose (Prometheus, exporter, socket proxy, dashboard) and the remote compose (agent, exporter,
  socket proxy); their `init.sh`; README and deploy docs replacing the systemd scripts.

## Testing

- Exporter: metrics rendered from collector snapshots built with the existing fixtures (MIG XML,
  DCGM discovery/dmon) plus a Jetson-style `nvidia-smi` line; unknown values produce no series; at
  most one GPU poll in flight; a scrape never runs a command; MIG on any of eight GPUs, appearing
  and disappearing, with and without partitions in the XML.
- Dashboard source, against a fake Prometheus (canned API responses): the same state as today for
  a server with partitions and for the Jetson; missing utilization → `null`; stale GPU timestamp →
  offline and `observe(ok: false)`; failing Prometheus → no server down, no idle alert,
  `Prometheus (nvtop)` down after 5 min; the range query fills the graphs.
- Existing tests for parsers, idle history, notifier and Teams cards keep passing; the SSH manager
  and its tests go away.
- Live: the spikes, and the parity check during the parallel run in *Rollout*.

## Spike results (2026-10-28, throwaway `docker run --rm` containers)

1. GPU server, `nvidia` runtime + `pid: host` + `/etc/passwd:ro` + `cap_drop: ALL`:
   `nvidia-smi --query-compute-apps` lists host processes and their owners resolve. **Passed.** MIG
   inside the container could not be checked: the MIG GPU left MIG mode before the spike.
   `NVIDIA_MIG_MONITOR_DEVICES=all` is refused without `CAP_SYS_ADMIN`, hence the DCGM fallback in
   *MIG*.
2. GPU server, the host's own `dcgmi` and `libdcgm.so.4` bind-mounted into a container on the host
   network: `dcgmi discovery` and `dcgmi dmon -e 1001,250,252` reach the host engine. **Passed**
   (on a whole GPU; no partition existed). Mounting the host's client keeps it on the host
   engine's version.
3. GPU server, `du` with `cap_drop: ALL` + `DAC_READ_SEARCH` reads the data disks. **Passed.** `df`
   in the container also lists the container's own bind mounts (`/etc/passwd`, `/etc/hosts`, …),
   so the exporter reports only mounts under `diskMountPrefixes`, and each data disk is
   bind-mounted at its own path.
4. `wollomatic/socket-proxy` on a Unix socket with only `GET /containers/json` allowed: list
   **passed**; `inspect`, `logs` and `images` answer 403, `POST …/stop` 405.
5. Jetson, `nvidia` runtime: `nvidia-smi`, process owners and `/proc/meminfo` work in a container.
   **Passed.**
6. Jetson → GPU server `:19090`: checked at deploy, when the agent's remote writes arrived.
   **Passed.**

## Decisions (2026-10-28)

1. The Jetson's GPU memory is system memory (`MemTotal − MemAvailable`), not the sum of process
   memory.
2. The GPU server's deployment lives on one of its data disks, not in a home directory, and runs
   under the deploying developer's account; the Prometheus and dashboard data folders live under
   it.
3. Dashboard port: `13000` (any free port was acceptable).
4. The deploying developer keeps the Prometheus basic-auth credentials.

## Left to the builder

- Module layout (e.g. the polling extracted from `collector.js` into a module the exporter runs,
  and a Prometheus source in the dashboard), exact metric names, PromQL queries, pinned image
  versions, and the freshness threshold (6–15 s).
