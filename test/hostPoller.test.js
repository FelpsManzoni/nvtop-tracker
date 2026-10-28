const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { HostPoller } = require('../src/hostPoller');
const { DEFAULTS } = require('../src/exporterConfig');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const ticks = async (n) => { for (let i = 0; i < n; i++) await tick(); };
const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const keys = (poller) => poller.snapshot().gpu.entries.map((e) => e.key);

// Fake host: the GPU query answers immediately, everything else (process queries) hangs until
// released, simulating a stuck `ps`/nvidia-smi.
function setup() {
  const pending = [];
  const poller = new HostPoller(DEFAULTS, {
    run: (cmd) =>
      cmd === DEFAULTS.gpuQueryCommand
        ? Promise.resolve('0, GPU, 0, 1, 10, 30\n')
        : new Promise((resolve) => pending.push({ cmd, resolve })),
  });
  return { poller, pending };
}

test('nothing is reported as attempted before the first poll', () => {
  const s = setup().poller.snapshot();
  assert.deepEqual([s.gpu.ok, s.processes.ok, s.mig.ok, s.disk.ok, s.containers.ok], [null, null, null, null, null]);
});

test('a hung process query does not hold back GPU readings', async () => {
  const { poller } = setup();
  await poller.pollGpu();
  const { gpu } = poller.snapshot();
  assert.strictEqual(gpu.ok, true);
  assert.strictEqual(gpu.entries[0].utilization, 0);
});

test('process polls do not overlap while one is in flight; the result shows once it lands', async () => {
  const { poller, pending } = setup();
  await poller.pollGpu();
  await poller.pollGpu();
  assert.strictEqual(pending.length, 2); // uuid + compute-apps from the first poll only

  pending.find((p) => p.cmd === DEFAULTS.gpuUuidQueryCommand).resolve('0, GPU-abc\n');
  pending.find((p) => p.cmd === DEFAULTS.gpuProcessesQueryCommand).resolve('GPU-abc, 42, /usr/bin/python, 100\n');
  await tick();
  pending.find((p) => p.cmd.startsWith('ps ')).resolve('42 jsilva python train.py\n');
  await tick();

  assert.deepEqual(
    poller.snapshot().processes.list.map((p) => [p.gpuKey, p.pid, p.owner, p.fullCommand]),
    [['0', 42, 'jsilva', 'python train.py']]
  );
  await poller.pollGpu();
  assert.strictEqual(pending.length, 5); // in-flight cleared, so a new process poll started
});

test('GPU polls do not overlap: a hung nvidia-smi is not started again every interval', () => {
  const calls = [];
  const poller = new HostPoller(DEFAULTS, { run: (cmd) => { calls.push(cmd); return new Promise(() => {}); } });
  poller.pollGpu();
  poller.pollGpu();
  poller.pollGpu();
  assert.strictEqual(calls.filter((c) => c === DEFAULTS.gpuQueryCommand).length, 1);
});

test('a failed GPU poll keeps the last success time and entries, and records the error', async () => {
  let fail = false;
  const poller = new HostPoller(DEFAULTS, {
    run: (cmd) => (cmd !== DEFAULTS.gpuQueryCommand ? Promise.resolve('') : fail ? Promise.reject(new Error('NVML: Unknown Error')) : Promise.resolve('0, GPU, 3, 1, 10, 30\n')),
  });
  await poller.pollGpu();
  const at = poller.snapshot().gpu.at;
  fail = true;
  await poller.pollGpu();
  const { gpu } = poller.snapshot();
  assert.deepEqual([gpu.ok, gpu.at, gpu.error, gpu.entries.length], [false, at, 'NVML: Unknown Error', 1]);
});

test('a GPU reporting [N/A] memory gets the machine memory when unifiedMemoryFallback is on (Jetson)', async () => {
  const run = async (cmd) => (cmd === DEFAULTS.gpuQueryCommand ? '0, NVIDIA Jetson, 0, [N/A], [N/A], 45\n' : '');
  const meminfo = () => 'MemTotal:       65536000 kB\nMemAvailable:   49152000 kB\n';
  const on = new HostPoller({ ...DEFAULTS, unifiedMemoryFallback: true }, { run, readFile: meminfo });
  await on.pollGpu();
  const [e] = on.snapshot().gpu.entries;
  assert.deepEqual([e.utilization, e.memory, e.unifiedMemory, e.temperature], [0, { used: 16000, total: 64000 }, true, 45]);

  const off = new HostPoller(DEFAULTS, { run, readFile: meminfo });
  await off.pollGpu();
  assert.deepEqual(off.snapshot().gpu.entries[0].memory, { used: null, total: null });

  const broken = new HostPoller({ ...DEFAULTS, unifiedMemoryFallback: true }, { run, readFile: () => { throw new Error('ENOENT'); } });
  await broken.pollGpu();
  assert.deepEqual(broken.snapshot().gpu.entries[0].memory, { used: null, total: null });
});

// Fake host with one whole GPU and one MIG GPU (GPU 7 reports [N/A]), from the real fixtures.
function setupMig({ dmon, migHang } = {}) {
  const ctl = { gpu7: '[N/A]' };
  const executed = [];
  const migCmd = DEFAULTS.migQueryCommand.replace('{gpu}', '7');
  const run = (cmd) => {
    executed.push(cmd);
    if (cmd === DEFAULTS.gpuQueryCommand) {
      return Promise.resolve(`0, NVIDIA GPU, 92, 1685, 143771, 27\n7, NVIDIA GPU, ${ctl.gpu7}, 33435, 143771, 47\n`);
    }
    if (cmd === DEFAULTS.gpuUuidQueryCommand) return Promise.resolve('0, GPU-a\n7, GPU-b\n');
    if (cmd === DEFAULTS.gpuProcessesQueryCommand) return Promise.resolve('GPU-b, 555, /usr/bin/python, 100\n');
    if (cmd === migCmd) return migHang ? new Promise(() => {}) : Promise.resolve(fx('mig-gpu.xml'));
    if (cmd === DEFAULTS.dcgmDiscoveryCommand) return Promise.resolve(fx('dcgm-discovery.txt'));
    if (cmd.startsWith('timeout 10 dcgmi dmon')) return dmon ? dmon() : Promise.resolve(fx('dcgm-dmon.txt'));
    if (cmd.startsWith('ps ')) return Promise.resolve('3978767 alice python train.py\n');
    return Promise.resolve('');
  };
  const poller = new HostPoller(DEFAULTS, { run });
  return { poller, ctl, executed, run };
}

test('a MIG GPU shows its partitions after the MIG poll lands', async () => {
  const { poller } = setupMig();
  await poller.pollGpu();
  assert.deepEqual(keys(poller), ['0', '7']);
  await ticks(3);
  await poller.pollGpu();
  const { entries } = poller.snapshot().gpu;
  assert.deepEqual(entries.map((e) => e.key), ['0', '7-1', '7-2', '7-3']);
  assert.deepEqual([entries[1].utilization, entries[1].memory], [84.5, { used: 831, total: 33280 }]);
  assert.strictEqual(poller.snapshot().mig.ok, true);
});

test('a DCGM failure leaves partitions with unknown utilization and other GPUs untouched', async () => {
  const { poller } = setupMig({ dmon: () => Promise.reject(new Error('connection refused')) });
  await poller.pollGpu();
  await ticks(3);
  await poller.pollGpu();
  assert.deepEqual(poller.snapshot().gpu.entries.map((e) => [e.key, e.utilization]), [['0', 92], ['7-1', null], ['7-2', null], ['7-3', null]]);
  assert.strictEqual(poller.snapshot().mig.ok, false);
});

test('a host without [N/A] GPUs runs no MIG commands', async () => {
  const executed = [];
  const poller = new HostPoller(DEFAULTS, {
    run: (cmd) => { executed.push(cmd); return Promise.resolve(cmd === DEFAULTS.gpuQueryCommand ? '0, GPU, 0, 1, 10, 30\n' : ''); },
  });
  await poller.pollGpu();
  await ticks(2);
  assert.ok(!executed.some((c) => c.includes('nvidia-smi -q -x') || c.includes('dcgmi')));
  assert.strictEqual(poller.snapshot().mig.ok, null);
});

test('MIG polls do not overlap', async () => {
  const { poller, executed } = setupMig({ migHang: true });
  await poller.pollGpu();
  await poller.pollGpu();
  assert.equal(executed.filter((c) => c === DEFAULTS.migQueryCommand.replace('{gpu}', '7')).length, 1);
});

test('cached MIG state is forgotten when a GPU leaves MIG mode', async () => {
  const { poller, ctl } = setupMig();
  await poller.pollGpu();
  await ticks(4);
  await poller.pollGpu();
  assert.deepEqual(keys(poller), ['0', '7-1', '7-2', '7-3']);
  assert.ok(poller.snapshot().processes.list.some((r) => r.gpuKey === '7-1' && r.owner === 'alice'));

  ctl.gpu7 = '40';
  await poller.pollGpu();
  assert.deepEqual(poller.snapshot().gpu.entries.map((e) => [e.key, e.utilization]), [['0', 92], ['7', 40]]);
  const rows7 = poller.snapshot().processes.list.filter((r) => r.gpuId === 7);
  assert.deepEqual(rows7.map((r) => [r.gpuKey, r.pid]), [['7', 555]]);
  assert.ok(!poller.mig.util.size);
});

test('a MIG poll that started before a GPU left and re-entered [N/A] does not publish its stale layout', async () => {
  const { poller, ctl, run } = setupMig();
  const migCmd = DEFAULTS.migQueryCommand.replace('{gpu}', '7');
  let release;
  poller.run = (cmd) => (cmd === migCmd ? new Promise((r) => { release = r; }) : run(cmd));
  await poller.pollGpu(); // poll A starts and hangs
  ctl.gpu7 = '40';
  await poller.pollGpu(); // GPU 7 numeric: evicted
  ctl.gpu7 = '[N/A]';
  await poller.pollGpu();
  release(fx('mig-gpu.xml'));
  await ticks(6);
  await poller.pollGpu();
  const gpu7 = poller.snapshot().gpu.entries.filter((e) => e.id === 7);
  assert.deepEqual(gpu7.map((e) => [e.key, e.utilization]), [['7', null]]);
});

// A host with eight GPUs. `mig` maps a GPU index to its partitions, each
// [gpuInstanceId, dcgmEntityId, activity, fbTotalMiB, fbUsedMiB]; it can change between polls.
// `xmlShowsPartitions: false` is how a container without the MIG monitor capability sees them.
function eightGpuHost({ mig = {}, xmlShowsPartitions = true, xmlFails = false } = {}) {
  const gpus = [0, 1, 2, 3, 4, 5, 6, 7];
  const run = async (cmd) => {
    if (cmd === DEFAULTS.gpuQueryCommand) {
      return gpus.map((i) => `${i}, NVIDIA GPU, ${mig[i] ? '[N/A]' : 50}, 1000, 143771, 40`).join('\n');
    }
    const xml = cmd.match(/nvidia-smi -q -x -i (\d+)/);
    if (xml) {
      if (xmlFails) throw new Error('Failed to initialize NVML');
      const parts = mig[Number(xml[1])];
      if (!parts) return '<nvidia_smi_log><gpu><mig_mode><current_mig>Disabled</current_mig></mig_mode></gpu></nvidia_smi_log>';
      const devices = xmlShowsPartitions
        ? parts.map(([gi, , , total, used], idx) =>
          `<mig_device><index>${idx}</index><gpu_instance_id>${gi}</gpu_instance_id><fb_memory_usage><total>${total} MiB</total><used>${used} MiB</used></fb_memory_usage></mig_device>`).join('')
        : '';
      return `<nvidia_smi_log><gpu><mig_mode><current_mig>Enabled</current_mig></mig_mode><mig_devices>${devices}</mig_devices></gpu></nvidia_smi_log>`;
    }
    if (cmd === DEFAULTS.dcgmDiscoveryCommand) {
      const rows = Object.entries(mig).flatMap(([g, parts]) => parts.map(([gi, e]) => `| -> I ${g}/${gi}          | GPU Instance (EntityID: ${e})     |`));
      return `| Instance Hierarchy |\n${rows.join('\n')}\n`;
    }
    if (cmd.includes('dcgmi dmon')) {
      const rows = Object.values(mig).flat();
      return [
        '#Entity  GRACT  FBTTL  FBUSD',
        ...rows.map(([, e]) => `GPU-I ${e}  N/A  N/A  N/A`),
        ...rows.map(([, e, act, total, used]) => `GPU-I ${e}  ${act}  ${total}  ${used}`),
      ].join('\n');
    }
    if (cmd === DEFAULTS.gpuUuidQueryCommand) return gpus.map((i) => `${i}, GPU-${i}`).join('\n');
    if (cmd === DEFAULTS.gpuProcessesQueryCommand) return 'GPU-2, 77, /usr/bin/python, 500\n';
    if (cmd.startsWith('ps ')) return '77 mcosta python serve.py\n';
    return '';
  };
  return { mig, poller: new HostPoller(DEFAULTS, { run }) };
}

const pollTwice = async (poller) => {
  await poller.pollGpu();
  await ticks(8);
  await poller.pollGpu();
};

test('MIG on any GPU: GPUs 2 and 7 each become one entry per partition', async () => {
  const { poller } = eightGpuHost({
    mig: { 2: [[1, 10, 0.25, 70000, 1000], [2, 11, 0, 70000, 0]], 7: [[3, 49, 0.845, 33280, 831], [5, 50, 0.871, 33280, 13433], [6, 51, 0.931, 33280, 19171]] },
  });
  await pollTwice(poller);
  const { entries } = poller.snapshot().gpu;
  assert.deepEqual(entries.map((e) => e.key), ['0', '1', '2-1', '2-2', '3', '4', '5', '6', '7-1', '7-2', '7-3']);
  const p = Object.fromEntries(entries.map((e) => [e.key, e]));
  assert.deepEqual([p['2-1'].utilization, p['2-1'].memory, p['2-1'].label], [25, { used: 1000, total: 70000 }, 'GPU 2 - 1']);
  assert.deepEqual([p['2-2'].utilization, p['7-3'].utilization], [0, 93.1]);
});

test('when the XML hides the partitions, the layout and memory come from DCGM and processes stay on the whole GPU', async () => {
  const { poller } = eightGpuHost({ xmlShowsPartitions: false, mig: { 2: [[1, 10, 0.25, 70000, 1000], [2, 11, 0, 70000, 0]] } });
  await pollTwice(poller);
  const { entries } = poller.snapshot().gpu;
  assert.deepEqual(entries.filter((e) => e.id === 2).map((e) => [e.key, e.utilization, e.memory.used, e.memory.total]), [
    ['2-1', 25, 1000, 70000],
    ['2-2', 0, 0, 70000],
  ]);
  assert.deepEqual(poller.snapshot().processes.list.map((r) => [r.gpuKey, r.gpuLabel, r.pid, r.owner]), [['2', 'GPU 2', 77, 'mcosta']]);
});

test('an unreadable XML falls back to the partitions DCGM knows', async () => {
  const { poller } = eightGpuHost({ xmlFails: true, mig: { 5: [[1, 30, 0.5, 70000, 10]] } });
  await pollTwice(poller);
  assert.deepEqual(poller.snapshot().gpu.entries.filter((e) => e.id === 5).map((e) => [e.key, e.utilization]), [['5-1', 50]]);
});

test('a GPU put into MIG mode while running gets its partitions, and is whole again when MIG is off', async () => {
  const { mig, poller } = eightGpuHost();
  await poller.pollGpu();
  assert.deepEqual(keys(poller), ['0', '1', '2', '3', '4', '5', '6', '7']);

  mig[4] = [[1, 20, 0.5, 70000, 10], [2, 21, 0.1, 70000, 20]];
  await poller.pollGpu();
  assert.deepEqual(poller.snapshot().gpu.entries.filter((e) => e.id === 4).map((e) => [e.key, e.utilization]), [['4', null]]);
  await ticks(8);
  await poller.pollGpu();
  assert.deepEqual(poller.snapshot().gpu.entries.filter((e) => e.id === 4).map((e) => [e.key, e.utilization]), [['4-1', 50], ['4-2', 10]]);

  delete mig[4];
  await poller.pollGpu();
  assert.deepEqual(poller.snapshot().gpu.entries.filter((e) => e.id === 4).map((e) => [e.key, e.utilization]), [['4', 50]]);
});

test('disk: only mounts under diskMountPrefixes are reported, each /data mount with its biggest folder', async () => {
  const df = [
    'Filesystem     Type     1024-blocks      Used Available Capacity Mounted on',
    '/dev/root ext4 500000000 300000000 200000000 60% /etc/passwd',
    '/dev/data1 ext4 1000000000 100000000 900000000 10% /data/disk1',
    'overlay overlay 1000000000 800000000 200000000 80% /data/disk2/docker/overlay2/x/merged',
    'overlay overlay 100 50 50 50% /',
  ].join('\n');
  const poller = new HostPoller({ ...DEFAULTS, diskMountPrefixes: ['/data'] }, {
    run: async (cmd) => (cmd === DEFAULTS.diskQueryCommand ? df : cmd.includes('du -x') ? '60000000\t/data/disk1/datasets\n99999992\t/data/disk1\n' : ''),
  });
  await poller.pollDisk();
  assert.deepEqual(poller.snapshot().disk.volumes, [{
    filesystem: '/dev/data1', mountpoint: '/data/disk1', used: 100000000, total: 1000000000, usagePercent: 10,
    topFolder: { path: '/data/disk1/datasets', sizeKb: 60000000 },
  }]);
});

test('containers: the list comes from the injected lister; a failure keeps the last list and is recorded', async () => {
  let fail = false;
  const poller = new HostPoller(DEFAULTS, {
    run: async () => '',
    listContainers: async () => {
      if (fail) throw new Error('docker api: HTTP 403');
      return [{ name: 'tracking-server', status: 'Up 2 hours', created: 1 }];
    },
  });
  await poller.pollContainers();
  fail = true;
  await poller.pollContainers();
  const { containers } = poller.snapshot();
  assert.deepEqual([containers.ok, containers.error, containers.list.map((c) => c.name)], [false, 'docker api: HTTP 403', ['tracking-server']]);
  assert.strictEqual(new HostPoller(DEFAULTS, { run: async () => '' }).snapshot().containers.ok, null); // no lister: never attempted
});

test('disk: diskMountPrefixes [] reports no mounts, null reports every real one', async () => {
  const df = 'Filesystem Type 1024-blocks Used Available Capacity Mounted on\n/dev/data1 ext4 100 10 90 10% /data/disk1\n';
  const run = async (cmd) => (cmd === DEFAULTS.diskQueryCommand ? df : '');
  const none = new HostPoller({ ...DEFAULTS, diskMountPrefixes: [], diskTopFolderMountPrefixes: [] }, { run });
  await none.pollDisk();
  assert.deepEqual(none.snapshot().disk.volumes, []);
  const all = new HostPoller({ ...DEFAULTS, diskTopFolderMountPrefixes: [] }, { run });
  await all.pollDisk();
  assert.deepEqual(all.snapshot().disk.volumes.map((v) => v.mountpoint), ['/data/disk1']);
});
