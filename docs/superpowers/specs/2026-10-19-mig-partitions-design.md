# MIG partitions — design

**Date:** 2026-10-19
**Status:** draft for review

## Why

GPU 7 on "H200 Server 1 (sd-mnshpc01)" was switched to MIG mode (three `2g.35gb`
partitions). Since then it has vanished from the dashboard: in MIG mode `nvidia-smi`
reports the GPU's utilization as `[N/A]`, and `parseGpuCsv` drops any line with a
non-numeric field, so the whole GPU disappears from the cards, the GPU list, the idle
timer and the idle history. Its processes still show in the GPU Processes block.

The user wants every MIG partition shown on the dashboard the same way a normal GPU is,
and wants this to keep working automatically if any other GPU, on any server, is later
put into MIG mode.

## Goals

- Every MIG partition appears as its own GPU entry, labelled `GPU <gpu> - <n>`
  (e.g. `GPU 7 - 1`, `GPU 7 - 2`, `GPU 7 - 3`), with the same features as a normal GPU:
  graph card, GPUs list row, utilization, memory, temperature, owner avatars,
  live idle timer / "in use" tag, and an Idle history row.
- MIG is detected per GPU at poll time from the data already collected — nothing is
  hard-coded to GPU 7 or to Server 1.
- Per-partition utilization comes from DCGM (`nv-hostengine`), queried over the same SSH
  connection.
- When DCGM is unavailable, partitions still appear (memory, temperature, owners) with
  utilization shown as `n/a`.

## Non-goals

- A card or graph for the MIG parent GPU itself (the user explicitly doesn't need it).
- Per-partition temperature or power: the hardware reports these per physical GPU, so all
  partitions of a GPU show the parent's temperature.
- Using the `dcgm-exporter` container on port 9400: as configured it exposes no
  per-partition activity metrics for MIG GPUs.
- Starting, configuring or installing DCGM on servers.
- Per-compute-instance breakdown inside a GPU instance (today each GPU instance has one
  compute instance; one entry per GPU instance is enough).

## Anti-goals (failure even if it "works")

- Recording idle time for a partition whose utilization is unknown. Unknown is never idle.
- A MIG or DCGM problem degrading anything else: non-MIG GPUs on the same server, other
  servers, the server's `connected` status, or GPU telemetry latency.
- Treating `null`/unknown utilization as `0` anywhere (JS `null < 1` is `true`; averages
  must skip unknowns, not count them as 0%).
- Any change in behavior for servers and GPUs without MIG.

## Facts gathered on Server 1 (read-only, 2026-10-17 and 2026-10-19)

- Driver 570.172.08. `nvidia-smi --query-gpu=...` prints GPU 7 as
  `7, NVIDIA H200 NVL, [N/A], 10301, 143771, 36` (utilization `[N/A]`; memory and
  temperature are numbers). `mig.mode.current` is `Enabled` for GPU 7 only.
- `nvidia-smi -q -x -i 7` (XML) lists `<mig_device>` entries with `<index>` (0..2),
  `<gpu_instance_id>` (3, 5, 6), `<compute_instance_id>` (0) and `<fb_memory_usage>`
  (`<total>33280 MiB</total>`, `<used>…</used>`; a second `total/used` pair inside
  `mig_device` is BAR1 and must not be confused with framebuffer). Its `<processes>`
  section gives each process's `<gpu_instance_id>`, `<compute_instance_id>`, `<pid>`,
  `<process_name>`, `<used_memory>` — this is how processes map to partitions.
- `nvidia-smi --query-compute-apps=gpu_uuid,...` reports MIG processes with the **parent**
  GPU's UUID, so it cannot attribute them to a partition on its own.
- `mig -lgi` / `mig -lci` fail with "Insufficient Permissions" for the SSH user — do not
  use them.
- DCGM: `nv-hostengine` runs as `nvidia-dcgm.service` (it was inactive on 2026-10-17 and
  active on 2026-10-19 — availability must be treated as variable). `dcgmi` 4.5.0.
  `dcgmi discovery -c` prints the hierarchy, e.g.
  `| -> I 7/3          | GPU Instance (EntityID: 49) |`, mapping GPU 7 / GPU-instance 3
  to DCGM entity 49 (5 → 50, 6 → 51).
- `dcgmi dmon -e 1001 -c 2 -d 1000 -i i:49,i:50,i:51` prints rows like
  `GPU-I 49        0.845`. Field 1001 (graphics engine active) is a 0–1 fraction. The
  **first sample of each run is `N/A`** (warm-up), so at least two samples are needed;
  one run took about a second. A non-MIG GPU queried the same way reports normally.
- When `nv-hostengine` is not running, `dcgmi` fails with
  "Unable to connect to host engine".
- The user's `config.json` overrides every `*Command` setting, including
  `gpuQueryCommand`, so the design must not rely on changing the default GPU query.

## Behavior

### Detection (per server, per GPU poll)

1. Run the existing GPU query as today.
2. Parse every line; a GPU whose utilization is not a number is kept (not dropped), with
   utilization unknown. This alone also fixes "a GPU vanishes when one field is `[N/A]`"
   for non-MIG causes.
3. For GPUs with unknown utilization, a **MIG poll** fetches the `nvidia-smi -q -x` XML
   for those GPU indexes (to learn whether they are in MIG mode, their partitions,
   partition memory and per-partition processes) and then, if any partitions exist, reads
   DCGM activity for them. *(Controller's call)* The MIG poll is asynchronous like today's
   process query — never on the GPU update's critical path, at most one in flight per
   server — and the GPU update uses its latest result.
4. A GPU in MIG mode is **replaced** by one entry per partition (ordered by the XML
   `<index>`, numbered from 1 for display). The parent GPU gets no entry of its own.
   Until the first MIG poll result for a GPU arrives (a couple of seconds after startup or
   after MIG is enabled), that GPU shows as a single entry with utilization `n/a`. GPUs
   whose XML shows they are not in MIG mode stay a single entry with utilization `n/a`.

### Partition entry

| Field | Source |
|---|---|
| label | `GPU <parent index> - <mig index + 1>` |
| utilization | DCGM field 1001 × 100, rounded; unknown if DCGM is unavailable, errors, or returns `N/A` |
| memory used / total | XML `<mig_device>` → `<fb_memory_usage>` |
| temperature | parent GPU's temperature from the GPU query |
| processes / owners | XML `<processes>` matched by `<gpu_instance_id>`; owners via the existing `ps` enrichment |

*(Controller's call)* The **GPU Processes block** labels MIG processes by partition
(`GPU 7 - 2`) instead of the parent GPU: for MIG GPUs the process rows come from the XML
`<processes>` (pid, name, memory, partition) and replace the parent-attributed rows from
`--query-compute-apps`; non-MIG GPUs keep using `--query-compute-apps`. All rows go
through the existing `ps` owner/command enrichment.

### Unknown utilization (DCGM down, or a non-MIG `[N/A]`)

- Card and GPUs list show utilization as `n/a`; the graph draws memory only.
- The card corner shows a `MIG` tag (partition) or `n/a` tag (non-MIG) instead of the idle
  timer / "in use"; owner avatars still show.
- Idle tracking: the sample is skipped for that entry — it neither starts, extends nor
  resets idle state. The entry's Idle history row shows `n/a` in both columns while its
  utilization is unknown *(controller's call)*. If DCGM stays down, the existing 5-minute gap rule closes any open
  idle period at the last known sample; when DCGM returns, tracking resumes.
- Server-level averages and trends (sidebar average, 1 m / 5 m averages, 5 m max) include
  only entries with a known utilization. Each partition counts as one entry
  *(controller's call — it matches how the dashboard lists them)*.
- The idle threshold is unchanged: utilization < 1% is idle. DCGM's fraction is converted
  to a percentage (×100) before the comparison; rounding is for display only.

### Identity

Every GPU entry gets a stable string key used for idle state, idle history, graph history
and process matching: the plain index for normal GPUs (`"0"` … `"7"`, so the existing
`data/idle-history.json` keeps working unchanged) and `"<gpu>-<n>"` for partitions
(`"7-1"`). If the partitions of a GPU are reshaped, entries simply appear/disappear; stale
idle state ages out through the existing gap rule. The Idle history card renders rows from
the live GPU entries only, so the saved state for the old `"7"` key is never shown and
ages out on its own.

*(Controller's call)* Wire format: each GPU entry keeps `id` (the physical GPU index, a
number) and gains `key` (string, as above) and `label` (`"GPU 7 - 1"` / `"GPU 0"`).
Everything that today keys by `id` — `historyByGpu`, `IdleHistory`, the rolling buffer,
owner matching, the cards — switches to `key`. `IdleHistory`'s saved-state loader must
accept string keys (today it coerces keys with `Number()`, which would break `"7-1"`).

### Timing and failure isolation

- The DCGM read must not delay GPU telemetry: like the process query today, it runs
  without blocking the GPU update, at most one in flight per server, and the latest
  result is used on the next update.
- *(Controller's call)* DCGM is "unavailable" when `dcgmi` is missing, cannot reach the
  host engine, exits non-zero, times out (each remote MIG command wrapped in
  `timeout 10`), or returns `N/A`. A DCGM reading older than 3 × `gpuPollIntervalMs` is
  treated as unknown, so the dashboard never shows stale utilization as current.
- DCGM / XML failures affect only the partition entries (utilization unknown, or the MIG
  GPU falls back to a single `n/a` entry if the XML can't be read); they never change the
  server's `connected` status.
- Servers with no MIG GPU run no extra commands.

### Configuration

Follow the existing pattern: any new remote command (XML query, DCGM discovery, DCGM
activity read) gets a configurable default in `src/config.js`, documented in the README
and `config.example.json`. Defaults must work with the user's existing `config.json`
(which overrides only the existing command keys).

## Testing

- Parser tests built from the real outputs above: the GPU line with `[N/A]`; the
  `-q -x` XML (MIG devices, BAR1 vs framebuffer, processes with GI ids); `dcgmi
  discovery -c` hierarchy; `dcgmi dmon` with the warm-up `N/A` row; the "Unable to connect
  to host engine" error.
- Idle tracking: unknown utilization samples don't start/extend/reset idle; a partition
  with known utilization tracks idle independently of its siblings.
- Collector: a server with one MIG GPU yields one entry per partition and no parent entry;
  DCGM failure → partitions with unknown utilization, other GPUs unaffected, `connected`
  unchanged; no-MIG server runs no extra commands.
- Manual: run against Server 1 and confirm `GPU 7 - 1..3` cards, utilization from DCGM,
  owners on the right partition, and Server 2 unchanged.

## Left to the builder

- Exact command strings and how the XML is parsed (a small targeted parser is fine; no
  new npm dependency without a reason).
- How often to refresh the MIG layout/DCGM entity mapping (every poll is acceptable;
  caching is fine if it can't serve stale layouts for long).
- Visual details of the `MIG` / `n/a` tags and the memory-only graph, matching the
  existing styles.
