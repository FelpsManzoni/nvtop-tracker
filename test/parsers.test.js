const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseGpuCsv,
  parseDf,
  parseDockerPs,
  parseDockerImages,
  parseGpuProcesses,
  parseDuTopFolder,
  parsePsOutput,
} = require('../src/parsers');

test('parseGpuCsv parses nvidia-smi csv output including GPU name', () => {
  const output = '0, NVIDIA H200 NVL, 85, 7500, 8000, 65\n1, NVIDIA H200 NVL, 12, 400, 8000, 40\n';
  const gpus = parseGpuCsv(output);
  assert.deepEqual(gpus, [
    { id: 0, name: 'NVIDIA H200 NVL', utilization: 85, memory: { used: 7500, total: 8000 }, temperature: 65 },
    { id: 1, name: 'NVIDIA H200 NVL', utilization: 12, memory: { used: 400, total: 8000 }, temperature: 40 },
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
    { gpuId: 0, pid: 1016695, process: 'python', fullCommand: '/data/venv/bin/python', memoryUsedMb: 50956 },
    { gpuId: 1, pid: 3908334, process: 'python3', fullCommand: '/data/venv/bin/python3', memoryUsedMb: 1832 },
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
