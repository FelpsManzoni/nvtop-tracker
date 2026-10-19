# MIG Partitions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every MIG partition as its own GPU entry (`GPU 7 - 1` …) with DCGM utilization, instead of the MIG GPU vanishing.

**Architecture:** `parseGpuCsv` keeps GPUs whose utilization is `[N/A]` (utilization `null`). For those, an async per-server **MIG poll** reads `nvidia-smi -q -x -i <gpu>` (partitions, memory, per-partition processes) and DCGM (`dcgmi discovery` + `dcgmi dmon`) for activity. A pure module `src/mig.js` turns the GPU list plus the latest MIG poll result into display entries; every entry carries a string `key` and a `label`, and everything that keyed by numeric `id` (idle history, rolling buffer, owner matching, cards) switches to `key`.

**Tech Stack:** Node.js >= 18, Express, `node:test`, vanilla JS frontend. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-19-mig-partitions-design.md`

## Global Constraints

- Node >= 18; no new npm dependencies; XML is parsed with small targeted regexes.
- Entry `key`: `String(index)` for whole GPUs (`"0"` … `"7"` — keeps `data/idle-history.json` valid); `"<gpu>-<n>"` for partitions, `n` = XML `<index>` + 1 (`"7-1"`).
- Entry `label`: `"GPU <gpu>"` or `"GPU <gpu> - <n>"` (`"GPU 7 - 1"`).
- Utilization is a number 0–100 or `null` (unknown). Unknown is never idle, never 0 in averages. Idle threshold unchanged: `< 1`.
- Partition utilization = DCGM field 1001 × 100; a reading older than `3 * gpuPollIntervalMs` is `null`.
- Partition temperature = parent GPU's temperature; partition memory = XML `<mig_device>` `<fb_memory_usage>` (never the `bar1_memory_usage` block).
- New config defaults (all remote commands wrapped in `timeout 10`):
  - `migQueryCommand`: `timeout 10 nvidia-smi -q -x -i {gpu}` (one GPU index per call)
  - `dcgmDiscoveryCommand`: `timeout 10 dcgmi discovery -c`
  - `dcgmActivityCommand`: `timeout 10 dcgmi dmon -e 1001 -c 2 -d 1000 -i {entities}` (`{entities}` = `i:49,i:50`)
- MIG/DCGM work never delays the GPU update, never changes `connected`, at most one MIG poll in flight per server, and servers with no `null`-utilization GPU run no extra commands.
- Branch `feat/mig-partitions`. Commit titles match `^(feature|feat|fix|docs|refactor|experiment|hotfix|test|chore): .+`. **Commit as** `GIT_AUTHOR_EMAIL=felipemanzoni3@gmail.com GIT_COMMITTER_EMAIL=felipemanzoni3@gmail.com git commit …` (the session env otherwise forces another address); every message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01DW6DKVihcwiQtNwhKmuinD
  ```
- Never push or merge.

## Review Focus

1. **One MIG GPU's XML query fails while another's succeeds** → only the failed GPU shows as a single `n/a` entry; the other still shows partitions. Test in Task 2 (`buildGpuEntries`).
2. **DCGM stops mid-run** → after `3 * gpuPollIntervalMs` partition utilization becomes `null` and idle state is neither started nor reset. Tests in Task 2 (staleness) and Task 1 (`IdleHistory` skips `null`).
3. **A partition with no DCGM entity** (discovery lacks it) → utilization `null`, partition still listed. Test in Task 2.
4. **A non-MIG GPU reporting `[N/A]`** (XML `current_mig` = `Disabled`) → one entry, utilization `null`, no partitions. Test in Task 2.
5. **A MIG process whose `gpu_instance_id` matches no partition** (layout changed between queries) → dropped, never attributed to the wrong partition. Test in Task 2 (`buildGpuProcesses`).

---

### Task 1: String keys, unknown utilization, and MIG/DCGM parsers

**Files:**
- Modify: `src/parsers.js` (`parseGpuCsv`, `parseGpuProcesses`; add three parsers)
- Modify: `src/idleHistory.js`, `src/rollingBuffer.js`
- Create: `test/fixtures/mig-gpu.xml`, `test/fixtures/dcgm-discovery.txt`, `test/fixtures/dcgm-dmon.txt`
- Test: `test/parsers.test.js`, `test/idleHistory.test.js`, `test/rollingBuffer.test.js`

**Interfaces:**
- Produces:
  - `parseGpuCsv(output)` → `[{ id: number, key: string, label: string, name, utilization: number|null, memory: {used,total}, temperature }]`. A line is kept when only utilization is non-numeric; any other non-numeric field still drops the line.
  - `parseGpuProcesses(...)` rows gain `gpuKey: String(gpuId)` and `gpuLabel: "GPU <gpuId>"`.
  - `parseMigXml(xml)` (single-GPU `nvidia-smi -q -x` output) → `{ migEnabled: boolean, devices: [{ migIndex: number, gpuInstanceId: number, memory: { used: number, total: number } }], processes: [{ gpuInstanceId: number|null, pid: number, process: string, fullCommand: string, memoryUsedMb: number }] }` (MiB numbers; `process` = basename of `process_name`).
  - `parseDcgmDiscovery(output)` → `Map<string, number>`, key `"<gpu>/<gpuInstance>"` → entity id (`"7/3"` → `49`).
  - `parseDcgmDmon(output)` → `Map<number, number>` entity id → last numeric value for that entity (`N/A` rows ignored).
  - `IdleHistory` is keyed by `key` (strings): `update(entries, now)` reads `entry.key`/`entry.utilization` and **skips entries whose utilization is not a finite number**; `summary(key, now)`; `annotate(entries, now)` uses `entry.key`; the constructor keeps saved keys as strings (no `Number()`).
  - `RollingBuffer.getHistoryByGpu()` is keyed by `gpu.key`; points keep `utilization: null` when unknown; `getTrends()` ignores `null` utilizations (all-null → `null` trends).

- [ ] **Step 1: Add the fixtures (anonymized from Server 1's real output)**

`test/fixtures/mig-gpu.xml` — a trimmed single-GPU document with this structure (keep tag order; values from the real capture):

```xml
<?xml version="1.0" ?>
<nvidia_smi_log>
	<gpu id="00000000:00:00.0">
		<mig_mode>
			<current_mig>Enabled</current_mig>
			<pending_mig>Enabled</pending_mig>
		</mig_mode>
		<mig_devices>
			<mig_device>
				<index>0</index>
				<gpu_instance_id>3</gpu_instance_id>
				<compute_instance_id>0</compute_instance_id>
				<fb_memory_usage>
					<total>33280 MiB</total>
					<reserved>0 MiB</reserved>
					<used>831 MiB</used>
					<free>32450 MiB</free>
				</fb_memory_usage>
				<bar1_memory_usage>
					<total>65535 MiB</total>
					<used>2 MiB</used>
					<free>65532 MiB</free>
				</bar1_memory_usage>
			</mig_device>
			<!-- same shape: index 1 / gi 5 / used 13433; index 2 / gi 6 / used 19171 -->
		</mig_devices>
		<minor_number>7</minor_number>
		<fb_memory_usage><total>143771 MiB</total><used>33435 MiB</used></fb_memory_usage>
		<temperature><gpu_temp>47 C</gpu_temp></temperature>
		<processes>
			<process_info>
				<gpu_instance_id>3</gpu_instance_id>
				<compute_instance_id>0</compute_instance_id>
				<pid>3978767</pid>
				<type>C</type>
				<process_name>python</process_name>
				<used_memory>740 MiB</used_memory>
			</process_info>
			<!-- gi 5 / pid 120122 / python / 13342 MiB; gi 6 / pid 31391 / /data/x/.venv/bin/python / 19134 MiB -->
		</processes>
	</gpu>
</nvidia_smi_log>
```

Write all three `mig_device` and all three `process_info` blocks out in full (the comments describe their values). Also add `test/fixtures/mig-disabled.xml`: same skeleton with `<current_mig>Disabled</current_mig>`, empty `<mig_devices>`, one process with `<gpu_instance_id>N/A</gpu_instance_id>`.

`test/fixtures/dcgm-discovery.txt` — the real `dcgmi discovery -c` table, including the lines:
```
| GPU 7             | GPU GPU-00000000-0000-0000-0000-000000000000 (EntityID: 7)         |
| -> I 7/3          | GPU Instance (EntityID: 49)                                        |
|    -> CI 7/3/0    | Compute Instance (EntityID: 49)                                    |
| -> I 7/5          | GPU Instance (EntityID: 50)                                        |
|    -> CI 7/5/0    | Compute Instance (EntityID: 50)                                    |
| -> I 7/6          | GPU Instance (EntityID: 51)                                        |
|    -> CI 7/6/0    | Compute Instance (EntityID: 51)                                    |
```

`test/fixtures/dcgm-dmon.txt` — the real `dcgmi dmon -e 1001 -c 2` output: header lines `#Entity   GRACT` / `ID`, a first row per entity with `N/A`, a second row per entity with `0.845`, `0.871`, `0.931`.

- [ ] **Step 2: Write failing parser tests in `test/parsers.test.js`**

```js
test('parseGpuCsv keeps a GPU whose utilization is [N/A] and adds key/label', () => {
  const gpus = parseGpuCsv('0, NVIDIA H200 NVL, 92, 71701, 143771, 47\n7, NVIDIA H200 NVL, [N/A], 10301, 143771, 36\n');
  assert.deepEqual(gpus.map((g) => [g.key, g.label, g.utilization]), [['0', 'GPU 0', 92], ['7', 'GPU 7', null]]);
  assert.deepEqual(gpus[1].memory, { used: 10301, total: 143771 });
});
test('parseGpuCsv still drops a line whose memory or temperature is not numeric', () => {
  assert.equal(parseGpuCsv('7, NVIDIA H200 NVL, 5, [N/A], 143771, 36\n').length, 0);
});
test('parseGpuProcesses rows carry gpuKey and gpuLabel', () => { /* existing fixture → gpuKey '0', gpuLabel 'GPU 0' */ });
test('parseMigXml reads partitions (framebuffer, not BAR1) and per-partition processes', () => {
  const r = parseMigXml(fs.readFileSync(path.join(__dirname, 'fixtures/mig-gpu.xml'), 'utf8'));
  assert.equal(r.migEnabled, true);
  assert.deepEqual(r.devices.map((d) => [d.migIndex, d.gpuInstanceId, d.memory.used, d.memory.total]),
    [[0, 3, 831, 33280], [1, 5, 13433, 33280], [2, 6, 19171, 33280]]);
  assert.deepEqual(r.processes.map((p) => [p.gpuInstanceId, p.pid, p.process, p.memoryUsedMb]),
    [[3, 3978767, 'python', 740], [5, 120122, 'python', 13342], [6, 31391, 'python', 19134]]);
});
test('parseMigXml on a non-MIG GPU', () => {
  const r = parseMigXml(fs.readFileSync(path.join(__dirname, 'fixtures/mig-disabled.xml'), 'utf8'));
  assert.equal(r.migEnabled, false);
  assert.deepEqual(r.devices, []);
  assert.equal(r.processes[0].gpuInstanceId, null);
});
test('parseMigXml returns migEnabled false and no devices for garbage', () => {
  assert.deepEqual(parseMigXml('not xml'), { migEnabled: false, devices: [], processes: [] });
});
test('parseDcgmDiscovery maps gpu/instance to entity id', () => {
  const m = parseDcgmDiscovery(fs.readFileSync(path.join(__dirname, 'fixtures/dcgm-discovery.txt'), 'utf8'));
  assert.deepEqual([...m], [['7/3', 49], ['7/5', 50], ['7/6', 51]]);
});
test('parseDcgmDmon keeps the last numeric value per entity and ignores N/A warm-up rows', () => {
  const m = parseDcgmDmon(fs.readFileSync(path.join(__dirname, 'fixtures/dcgm-dmon.txt'), 'utf8'));
  assert.deepEqual([...m], [[49, 0.845], [50, 0.871], [51, 0.931]]);
});
test('parseDcgmDmon returns an empty map for the host-engine error text', () => {
  assert.equal(parseDcgmDmon('Error: Unable to connect to host engine. Host engine connection invalid/disconnected.').size, 0);
});
```

- [ ] **Step 3: Convert idle-history and rolling-buffer tests to string keys and add the unknown-utilization tests**

In `test/idleHistory.test.js`: every `{ id: N, utilization }` sample becomes `{ key: 'N', utilization }` and every `summary(N, …)` becomes `summary('N', …)`; saved-state objects keep their string keys. Add:

```js
test('an unknown (null) utilization sample neither starts, extends nor resets idle state', () => {
  const h = new IdleHistory();
  h.update([{ key: '7-1', utilization: 0 }], 0);
  h.update([{ key: '7-1', utilization: null }], MIN);
  assert.strictEqual(h.summary('7-1', MIN).idleSince, 0);
  const fresh = new IdleHistory();
  fresh.update([{ key: '7-1', utilization: null }], 0);
  assert.deepStrictEqual(fresh.summary('7-1', 0), { idleSince: null, lastIdleMs: null, idle30dMs: 0 });
});
test('partition keys are tracked independently and survive a JSON round trip', () => {
  const h = new IdleHistory();
  h.update([{ key: '7-1', utilization: 0 }, { key: '7-2', utilization: 80 }], 1000);
  const r = IdleHistory.fromJSON(JSON.parse(JSON.stringify(h.toJSON())));
  assert.strictEqual(r.summary('7-1', 1000).idleSince, 1000);
  assert.strictEqual(r.summary('7-2', 1000).idleSince, null);
});
```

In `test/rollingBuffer.test.js`: switch GPU fixtures to carry `key`, assert `getHistoryByGpu()` is keyed by `key`, and add a test that `getTrends()` over samples `[{key:'0',utilization:50},{key:'7-1',utilization:null}]` returns `gpuAvgUtilization1m: 50` and that all-`null` samples give `null` trends.

- [ ] **Step 4: Run tests to verify they fail**

Run: `node --test test/parsers.test.js test/idleHistory.test.js test/rollingBuffer.test.js`
Expected: FAIL — `parseMigXml is not a function`, missing `key`, `summary('0')` returning the empty summary.

- [ ] **Step 5: Implement**

- `src/parsers.js`: change `parseGpuCsv`/`parseGpuProcesses` per Interfaces; add `parseMigXml(xml)` (split on `<mig_device>` blocks, take each block's `<fb_memory_usage>` section; split `<processes>` on `<process_info>`; `N/A` gpu_instance_id → `null`), `parseDcgmDiscovery(output)` (regex `I (\d+)\/(\d+)\s*\|.*EntityID:\s*(\d+)`), `parseDcgmDmon(output)` (rows `GPU-I <id> <value>`; skip non-numeric values); export all three.
- `src/idleHistory.js`, `src/rollingBuffer.js`: per Interfaces.
- `src/collector.js`: no change needed in this task; it already passes parser output straight through (`key` now present).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all pass (existing collector tests still pass — the fake GPU line has a numeric utilization).

- [ ] **Step 7: Commit**

```bash
git add src/parsers.js src/idleHistory.js src/rollingBuffer.js test/
GIT_AUTHOR_EMAIL=felipemanzoni3@gmail.com GIT_COMMITTER_EMAIL=felipemanzoni3@gmail.com git commit -m "feat: key GPUs by string, keep [N/A] GPUs, and parse MIG/DCGM output" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DW6DKVihcwiQtNwhKmuinD"
```

---

### Task 2: MIG poll in the collector and partition entries

**Files:**
- Create: `src/mig.js`
- Modify: `src/collector.js` (MIG poll, base-process storage, entry building), `src/config.js` (three command defaults)
- Modify: `README.md` (config table rows + a feature line), `config.example.json`
- Test: `test/mig.test.js` (new), `test/collector.test.js`

**Interfaces:**
- Consumes: Task 1's `parseGpuCsv`, `parseMigXml`, `parseDcgmDiscovery`, `parseDcgmDmon`, keyed `IdleHistory`/`RollingBuffer`, `parseGpuProcesses` rows with `gpuKey`/`gpuLabel`.
- Produces:
  - `src/mig.js` exports:
    - `buildGpuEntries(gpus, migByGpu, utilByInstance, now, staleMs)` → entries. `migByGpu: Map<number, parseMigXml result>`; `utilByInstance: Map<string "<gpu>/<gi>", { value: number /*0–1*/, at: number }>`. A GPU with `utilization === null` and `migByGpu.get(id)?.migEnabled` with ≥1 device is **replaced** by one entry per device (ordered by `migIndex`): `{ id, key: "<id>-<n>", label: "GPU <id> - <n>", name, mig: true, gpuInstanceId, utilization: fresh ? Math.round(value*1000)/10 : null, memory: device.memory, temperature: parent.temperature }`; every other GPU passes through unchanged with `mig: false`.
    - `buildGpuProcesses(baseProcesses, migByGpu)` → rows: base rows whose `gpuId` is a MIG-enabled GPU in `migByGpu` are removed; that GPU's XML processes are added as `{ gpuId, gpuKey: "<id>-<n>", gpuLabel: "GPU <id> - <n>", pid, process, fullCommand, memoryUsedMb, owner?, avatarUrl? }`, `n` from the device with the same `gpuInstanceId`; XML processes with no matching device are dropped.
  - Collector state per server: `this.mig: Map<serverName, { byGpu: Map, util: Map }>`, `this.migPollsInFlight: Set`, `this.baseProcesses: Map<serverName, rows>`; `_pollMig(ssh, serverName, gpuIndexes)`.
  - Config: `migQueryCommand`, `dcgmDiscoveryCommand`, `dcgmActivityCommand` (values in Global Constraints); `{gpu}` / `{entities}` are substituted by the collector.

- [ ] **Step 1: Write failing tests in `test/mig.test.js`**

Use `gpu0 = { id: 0, key: '0', label: 'GPU 0', name: 'NVIDIA H200 NVL', utilization: 92, memory: {used: 1685, total: 143771}, temperature: 27 }`, `gpu7 = { id: 7, key: '7', label: 'GPU 7', name: 'NVIDIA H200 NVL', utilization: null, memory: {used: 33435, total: 143771}, temperature: 47 }`, and `mig7` = the parsed `test/fixtures/mig-gpu.xml`.

```js
test('a MIG GPU is replaced by one entry per partition with DCGM utilization', () => {
  const util = new Map([['7/3', { value: 0.845, at: 1000 }], ['7/5', { value: 0.871, at: 1000 }], ['7/6', { value: 0.931, at: 1000 }]]);
  const e = buildGpuEntries([gpu0, gpu7], new Map([[7, mig7]]), util, 2000, 6000);
  assert.deepEqual(e.map((x) => [x.key, x.label, x.utilization, x.memory.used, x.temperature, x.mig]), [
    ['0', 'GPU 0', 92, 1685, 27, false],
    ['7-1', 'GPU 7 - 1', 84.5, 831, 47, true],
    ['7-2', 'GPU 7 - 2', 87.1, 13433, 47, true],
    ['7-3', 'GPU 7 - 3', 93.1, 19171, 47, true],
  ]);
});
test('a DCGM reading older than staleMs is unknown', () => { /* at: 1000, now: 8000, staleMs: 6000 → all three utilization null, entries still present */ });
test('a partition with no DCGM entity has unknown utilization', () => { /* util lacks '7/5' → '7-2' utilization null */ });
test('a GPU whose XML query failed stays a single n/a entry', () => { /* migByGpu empty → one entry key '7', utilization null, mig false */ });
test('a non-MIG GPU reporting [N/A] stays a single entry', () => { /* migByGpu 7 → parsed mig-disabled.xml → key '7', utilization null */ });
test('buildGpuProcesses relabels MIG processes per partition and drops unmatched ones', () => {
  const base = [{ gpuId: 0, gpuKey: '0', gpuLabel: 'GPU 0', pid: 1 }, { gpuId: 7, gpuKey: '7', gpuLabel: 'GPU 7', pid: 3978767 }];
  const mig = { ...mig7, processes: [...mig7.processes, { gpuInstanceId: 9, pid: 42, process: 'x', fullCommand: 'x', memoryUsedMb: 1 }] };
  const rows = buildGpuProcesses(base, new Map([[7, mig]]));
  assert.deepEqual(rows.map((r) => [r.gpuKey, r.gpuLabel, r.pid]), [
    ['0', 'GPU 0', 1], ['7-1', 'GPU 7 - 1', 3978767], ['7-2', 'GPU 7 - 2', 120122], ['7-3', 'GPU 7 - 3', 31391],
  ]);
});
```

- [ ] **Step 2: Write failing collector tests in `test/collector.test.js`**

Add a `setupMig()` fake SSH that answers: the GPU query with `gpu0` + `[N/A]` GPU 7 lines; `migQueryCommand` with `{gpu}`=7 → the `mig-gpu.xml` fixture; discovery → fixture; dmon → fixture; `ps` → owner lines; everything else → `''`. Record every executed command.

```js
test('a server with a MIG GPU shows its partitions after the MIG poll lands', async () => {
  const { collector, updates, server } = setupMig();
  await collector._pollGpu(server);            // first update: GPU 7 as one n/a entry, MIG poll started
  assert.deepEqual(updates[0].gpu.map((g) => g.key), ['0', '7']);
  await tick(); await tick(); await tick();
  await collector._pollGpu(server);
  const last = updates.at(-1);
  assert.deepEqual(last.gpu.map((g) => g.key), ['0', '7-1', '7-2', '7-3']);
  assert.equal(last.gpu[1].utilization, 84.5);
  assert.equal(last.connected, true);
});
test('a DCGM failure leaves partitions with unknown utilization and other GPUs untouched', async () => { /* dmon throws → after poll: '7-1'..'7-3' utilization null, '0' still 92, connected true */ });
test('a server without [N/A] GPUs runs no MIG commands', async () => { /* existing setup(); after _pollGpu, no executed command contains 'nvidia-smi -q -x' or 'dcgmi' */ });
test('MIG polls do not overlap', async () => { /* make migQueryCommand hang; two _pollGpu calls → one migQueryCommand executed */ });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/mig.test.js test/collector.test.js`
Expected: FAIL — `Cannot find module '../src/mig'`, partition keys absent.

- [ ] **Step 4: Implement**

- `src/mig.js`: `buildGpuEntries`, `buildGpuProcesses` per Interfaces.
- `src/config.js`: add the three defaults.
- `src/collector.js`:
  - The process poll stores its result in `this.baseProcesses` instead of `state.gpuProcesses`.
  - In `_pollGpu`, after `parseGpuCsv`: if any GPU has `utilization === null` and no MIG poll is in flight for the server, start `_pollMig(ssh, server.name, <those indexes>)` without awaiting (same in-flight pattern as the process poll).
  - Then build `entries = buildGpuEntries(gpus, mig.byGpu, mig.util, now, 3 * this.config.gpuPollIntervalMs)`, push/update/annotate with `entries`, and set `state.gpuProcesses = buildGpuProcesses(baseProcesses, mig.byGpu)`.
  - `_pollMig` runs `migQueryCommand` once per index (`{gpu}` replaced). Successful parses replace that GPU's `byGpu` entry; a failed one deletes it.
  - Owners for XML processes come from `_attachProcessOwners`. If any partitions exist, it runs `dcgmDiscoveryCommand` and then `dcgmActivityCommand` with `{entities}` = `i:<id>` joined by commas for known entities, and stores `{ value, at: Date.now() }` per `"<gpu>/<gi>"`.
  - Any DCGM error is caught and leaves `util` untouched; staleness turns old readings into `null`. Never touches `connected`.
- `README.md`: one Features bullet ("MIG partitions: each partition of a MIG GPU shows as `GPU <n> - <k>`; utilization comes from DCGM (`nv-hostengine` must run on the server), otherwise `n/a`") and three config-table rows. `config.example.json`: add the three keys.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass, output pristine.

- [ ] **Step 6: Commit**

```bash
git add src/mig.js src/collector.js src/config.js README.md config.example.json test/
GIT_AUTHOR_EMAIL=felipemanzoni3@gmail.com GIT_COMMITTER_EMAIL=felipemanzoni3@gmail.com git commit -m "feat: show MIG partitions as GPU entries using DCGM utilization" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DW6DKVihcwiQtNwhKmuinD"
```

---

### Task 3: Dashboard rendering of keys, labels and unknown utilization

**Files:**
- Modify: `public/app.js` (server average, GPU card, owners, status tag, graph, GPUs list, GPU Processes rows, Idle history card)
- Modify: `public/style.css` (one tag style)

**Interfaces:**
- Consumes: each `state.gpu[i]` has `key`, `label`, `mig`, `utilization: number|null` (plus the existing idle fields); `state.historyByGpu` keyed by `key` with `utilization: null` points; `state.gpuProcesses` rows have `gpuKey`, `gpuLabel`.

- [ ] **Step 1: Apply the rendering changes**

- Sidebar average (`public/app.js:26-27`): average only finite utilizations; `null` (shown `—`) when none are known.
- Card title, GPUs list name, Idle history row: `escapeHtml(gpu.label)` instead of `GPU ${gpu.id}`.
- Owners: match `p.gpuKey === gpu.key` (`renderGpuOwners(gpu.key, …)`).
- Status corner (`renderGpuStatus`): keep the existing `offline` branch first. When `gpu.utilization == null`, render the owner avatars plus a `<span class="gpu-tag">MIG</span>` if `gpu.mig`, else `<span class="gpu-tag">n/a</span>`, and no `.gpu-idle` element, so the 1 s ticker skips it. Otherwise render as today.
- Graph: look history up by `state.historyByGpu[g.key]`; the utilization polyline only uses points with a finite `utilization`; the memory polyline is unchanged.
- GPUs list stats: `n/a` in place of `${g.utilization}%` when `null`.
- GPU Processes rows: `escapeHtml(p.gpuLabel)` in place of `GPU ${p.gpuId}`.
- Idle history rows: `n/a` in both value columns when `g.utilization == null`.
- `public/style.css`: `.gpu-tag` styled like `.gpu-offline` but neutral (e.g. `background: #3a3f4b; color: #ccc;`).

- [ ] **Step 2: Check syntax and suite**

Run: `node --check public/app.js && npm test`
Expected: no syntax error; all tests pass.

- [ ] **Step 3: Commit**

```bash
git add public/app.js public/style.css
GIT_AUTHOR_EMAIL=felipemanzoni3@gmail.com GIT_COMMITTER_EMAIL=felipemanzoni3@gmail.com git commit -m "feat: render MIG partitions and unknown utilization on the dashboard" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DW6DKVihcwiQtNwhKmuinD"
```

- [ ] **Step 4: Verify against the real servers (controller)**

Run the app on a spare port, e.g. via a preload that overrides `config.port`. The service on :3000 is left alone.

Expected:
- **Server 1 cards:** `GPU 0`–`GPU 6` and `GPU 7 - 1`, `GPU 7 - 2`, `GPU 7 - 3`, with no plain `GPU 7` card.
- **Partition utilization** close to `dcgmi dmon` readings.
- **Owners** on the right partition.
- **GPU Processes** rows labelled `GPU 7 - n`.
- **Idle history** has rows for the partitions.
- **Server 2** unchanged.

Then stop `nv-hostengine` access in the test only: point `dcgmActivityCommand` at `false` through the preload. Within about 6 s, partitions should show `n/a` and the `MIG` tag.
