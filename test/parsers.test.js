const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {
  parseGpuCsv,
  parseDf,
  parseDockerPs,
  parseDockerImages,
  parseGpuProcesses,
  parseDuTopFolder,
  parsePsOutput,
  parseMigXml,
  parseDcgmDiscovery,
  parseDcgmDmon,
} = require('../src/parsers');

test('parseGpuCsv parses nvidia-smi csv output including GPU name', () => {
  const output = '0, NVIDIA H200 NVL, 85, 7500, 8000, 65\n1, NVIDIA H200 NVL, 12, 400, 8000, 40\n';
  const gpus = parseGpuCsv(output);
  assert.deepEqual(gpus, [
    { id: 0, key: '0', label: 'GPU 0', name: 'NVIDIA H200 NVL', utilization: 85, memory: { used: 7500, total: 8000 }, temperature: 65 },
    { id: 1, key: '1', label: 'GPU 1', name: 'NVIDIA H200 NVL', utilization: 12, memory: { used: 400, total: 8000 }, temperature: 40 },
  ]);
});

test('parseGpuCsv skips malformed lines instead of throwing', () => {
  const output = '0, NVIDIA H200 NVL, 85, 7500, 8000, 65\ngarbage line\n1, NVIDIA H200 NVL, 12, 400, 8000, 40\n';
  const gpus = parseGpuCsv(output);
  assert.equal(gpus.length, 2);
  assert.equal(gpus[1].id, 1);
});

test('parseGpuCsv returns empty array for empty output', () => {
  assert.deepEqual(parseGpuCsv(''), []);
});

test('parseDf parses df -kPT output, skips virtual filesystems, flags alert threshold', () => {
  const output = [
    'Filesystem     Type     1024-blocks      Used Available Capacity Mounted on',
    '/dev/sda1      ext4       524288000 471859200  52428800      90% /',
    'tmpfs          tmpfs        8192000         0   8192000       0% /dev/shm',
    'efivarfs       efivarfs          304       213         87      72% /sys/firmware/efi/efivars',
    '/dev/sdb1      xfs       1048576000 524288000 524288000      50% /data',
    '',
  ].join('\n');
  const volumes = parseDf(output, 85);
  assert.equal(volumes.length, 1);
  assert.deepEqual(volumes[0], {
    filesystem: '/dev/sdb1',
    mountpoint: '/data',
    used: 524288000,
    total: 1048576000,
    usagePercent: 50,
    alert: false,
  });
});

test('parseDf excludes the root filesystem and everything under /boot regardless of usage', () => {
  const output = [
    'Filesystem     Type     1024-blocks      Used Available Capacity Mounted on',
    '/dev/sda1      ext4       524288000 471859200  52428800      90% /',
    '/dev/sda2      ext4         2000000    225000    1646000      13% /boot',
    '/dev/sda3      vfat         1098632      6300    1092332       1% /boot/efi',
    '',
  ].join('\n');
  assert.deepEqual(parseDf(output, 85), []);
});

test('parseDockerPs parses running containers only (docker ps, not -a)', () => {
  const output = ['vla-manager-beat-1\tUp 7 days', 'mlflow-server\tUp 6 days (healthy)', ''].join('\n');
  assert.deepEqual(parseDockerPs(output), [
    { name: 'vla-manager-beat-1', status: 'Up 7 days' },
    { name: 'mlflow-server', status: 'Up 6 days (healthy)' },
  ]);
});

test('parseDockerPs returns empty array for empty output', () => {
  assert.deepEqual(parseDockerPs(''), []);
});

test('parseDockerImages skips dangling <none>:<none> images', () => {
  const output = [
    'kitti-scs:h200\t13 days ago',
    '<none>:<none>\t2 weeks ago',
    'vla-train:latest\t1 day ago',
    '',
  ].join('\n');
  assert.deepEqual(parseDockerImages(output), [
    { repoTag: 'kitti-scs:h200', created: '13 days ago' },
    { repoTag: 'vla-train:latest', created: '1 day ago' },
  ]);
});

test('parseGpuProcesses joins compute-apps output with gpu_uuid->index mapping', () => {
  const uuidOutput = ['0, GPU-aaaa', '1, GPU-bbbb', ''].join('\n');
  const procOutput = [
    'GPU-aaaa, 1016695, /data/venv/bin/python, 50956 MiB',
    'GPU-bbbb, 3908334, /data/venv/bin/python3, 1832 MiB',
    '',
  ].join('\n');
  assert.deepEqual(parseGpuProcesses(procOutput, uuidOutput), [
    { gpuId: 0, gpuKey: '0', gpuLabel: 'GPU 0', pid: 1016695, process: 'python', fullCommand: '/data/venv/bin/python', memoryUsedMb: 50956 },
    { gpuId: 1, gpuKey: '1', gpuLabel: 'GPU 1', pid: 3908334, process: 'python3', fullCommand: '/data/venv/bin/python3', memoryUsedMb: 1832 },
  ]);
});

test('parseGpuProcesses skips processes whose GPU uuid is unknown', () => {
  const uuidOutput = '0, GPU-aaaa\n';
  const procOutput = 'GPU-unknown, 1, /bin/foo, 10 MiB\n';
  assert.deepEqual(parseGpuProcesses(procOutput, uuidOutput), []);
});

test('parsePsOutput maps pid -> {user, args} from `ps -o pid=,user=,args=`', () => {
  const output = [
    '1016695 alice    /data/venv/bin/python train.py --config x.yaml',
    '3908334 bob      /data/venv/bin/python3 -m serve --port 8080',
    '',
  ].join('\n');
  const byPid = parsePsOutput(output);
  assert.deepEqual(byPid.get(1016695), { user: 'alice', args: '/data/venv/bin/python train.py --config x.yaml' });
  assert.deepEqual(byPid.get(3908334), { user: 'bob', args: '/data/venv/bin/python3 -m serve --port 8080' });
});

test('parsePsOutput returns an empty map for empty output', () => {
  assert.equal(parsePsOutput('').size, 0);
});

test('parseDuTopFolder picks the largest immediate subfolder, excluding the mount total line', () => {
  const output = ['16\t/data/x/lost+found', '349273060\t/data/x/m.raposo', '349273600\t/data/x', ''].join('\n');
  assert.deepEqual(parseDuTopFolder(output, '/data/x'), { path: '/data/x/m.raposo', sizeKb: 349273060 });
});

test('parseDuTopFolder ignores unparseable lines (e.g. "du: cannot read directory" permission warnings)', () => {
  const output = [
    "du: cannot read directory '/data/x/a/secret': Permission denied",
    '100\t/data/x/a',
    '900\t/data/x/b',
    '1000\t/data/x',
    '',
  ].join('\n');
  assert.deepEqual(parseDuTopFolder(output, '/data/x'), { path: '/data/x/b', sizeKb: 900 });
});

test('parseDuTopFolder returns null when there are no subfolders (or the scan produced nothing)', () => {
  assert.equal(parseDuTopFolder('', '/data/x'), null);
  assert.equal(parseDuTopFolder('1000\t/data/x\n', '/data/x'), null);
});

test('parsePsOutput keeps usernames longer than 8 chars from `ps -o user:64=`', () => {
  const byPid = parsePsOutput('42 f.manzoni                                                         python train.py\n');
  assert.deepEqual(byPid.get(42), { user: 'f.manzoni', args: 'python train.py' });
});

test('parseGpuCsv keeps a GPU whose utilization is [N/A] and adds key/label', () => {
  const gpus = parseGpuCsv('0, NVIDIA H200 NVL, 92, 71701, 143771, 47\n7, NVIDIA H200 NVL, [N/A], 10301, 143771, 36\n');
  assert.deepEqual(gpus.map((g) => [g.key, g.label, g.utilization]), [['0', 'GPU 0', 92], ['7', 'GPU 7', null]]);
  assert.deepEqual(gpus[1].memory, { used: 10301, total: 143771 });
});
test('parseGpuCsv still drops a line whose memory or temperature is not numeric', () => {
  assert.equal(parseGpuCsv('7, NVIDIA H200 NVL, 5, [N/A], 143771, 36\n').length, 0);
});
test('parseGpuProcesses rows carry gpuKey and gpuLabel', () => {
  const rows = parseGpuProcesses('GPU-aaaa, 1016695, /data/venv/bin/python, 50956 MiB\n', '0, GPU-aaaa\n');
  assert.equal(rows[0].gpuKey, String(rows[0].gpuId));
  assert.equal(rows[0].gpuKey, '0');
  assert.equal(rows[0].gpuLabel, 'GPU 0');
});
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
