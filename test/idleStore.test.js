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
  t.mock.method(console, 'warn', () => {});
  for (const content of ['not json', 'null', JSON.stringify({ version: 99, servers: {} }), JSON.stringify({ version: 1, servers: [] })]) {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    assert.deepStrictEqual(load(file), {});
    assert.ok(!fs.existsSync(file));
    const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('idle-history.json.corrupt-'));
    assert.strictEqual(backups.length, 1);
  }
});
