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
  const warn = t.mock.method(console, 'warn', () => {});
  for (const content of ['not json', 'null', JSON.stringify({ version: 99, servers: {} }), JSON.stringify({ version: 1, servers: [] })]) {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    assert.deepStrictEqual(load(file), {});
    assert.ok(!fs.existsSync(file));
    const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('idle-history.json.corrupt-'));
    assert.strictEqual(backups.length, 1);
    assert.match(warn.mock.calls.at(-1).arguments[0], /moved to .*\.corrupt-/);
  }
});

test('an unreadable file (e.g. EACCES) is moved aside too, not left to be overwritten', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}');
  t.mock.method(fs, 'readFileSync', () => {
    throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
  });
  assert.deepStrictEqual(load(file), {});
  assert.ok(!fs.existsSync(file));
  const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('idle-history.json.corrupt-'));
  assert.strictEqual(backups.length, 1);
  assert.match(warn.mock.calls[0].arguments[0], /cannot be read .*moved to/);
});

test('a failed backup is reported truthfully and load still returns empty', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not json');
  t.mock.method(fs, 'renameSync', () => {
    throw new Error('read-only file system');
  });
  assert.deepStrictEqual(load(file), {});
  assert.match(warn.mock.calls[0].arguments[0], /could not move it aside/);
});
