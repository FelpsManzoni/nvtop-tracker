const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGpuCsv, parseDf } = require('../src/parsers');

test('parseGpuCsv parses nvidia-smi csv output', () => {
  const output = '0, 85, 7500, 8000, 65\n1, 12, 400, 8000, 40\n';
  const gpus = parseGpuCsv(output);
  assert.deepEqual(gpus, [
    { id: 0, utilization: 85, memory: { used: 7500, total: 8000 }, temperature: 65 },
    { id: 1, utilization: 12, memory: { used: 400, total: 8000 }, temperature: 40 },
  ]);
});

test('parseGpuCsv skips malformed lines instead of throwing', () => {
  const output = '0, 85, 7500, 8000, 65\ngarbage line\n1, 12, 400, 8000, 40\n';
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
  assert.equal(volumes.length, 2);
  assert.deepEqual(volumes[0], {
    filesystem: '/dev/sda1',
    mountpoint: '/',
    used: 471859200,
    total: 524288000,
    usagePercent: 90,
    alert: true,
  });
  assert.equal(volumes[1].alert, false);
});
