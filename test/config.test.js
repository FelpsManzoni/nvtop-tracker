const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../src/config');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 'config.json');

test('loadConfig rejects a malformed userAvatars map', () => {
  const file = tmpFile();
  for (const bad of [null, [], { 'jsilva': 42 }]) {
    fs.writeFileSync(file, JSON.stringify({ userAvatars: bad }));
    assert.throws(() => loadConfig(file), /userAvatars/);
  }
  fs.writeFileSync(file, JSON.stringify({ userAvatars: { 'jsilva': 'a.png' } }));
  assert.deepStrictEqual(loadConfig(file).userAvatars, { 'jsilva': 'a.png' });
});

test('loadConfig rejects a non-string idleHistoryFile', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ idleHistoryFile: 42 }));
  assert.throws(() => loadConfig(file), /idleHistoryFile/);
});

test('loadConfig rejects a bad teamsWebhookUrl', () => {
  const file = tmpFile();
  for (const bad of [42, 'http://x', 'https://x/invoke?api-version\\=1']) {
    fs.writeFileSync(file, JSON.stringify({ teamsWebhookUrl: bad }));
    assert.throws(() => loadConfig(file), /teamsWebhookUrl/);
  }
  fs.writeFileSync(file, JSON.stringify({ teamsWebhookUrl: '' }));
  assert.equal(loadConfig(file).teamsWebhookUrl, '');
  assert.equal(loadConfig(path.join(os.tmpdir(), 'nonexistent-cfg.json')).teamsWebhookUrl, '');
});

test('loadConfig requires named servers and an http(s) prometheusUrl', () => {
  const file = tmpFile();
  for (const bad of [{ servers: {} }, { servers: [{ host: 'gpu-server-1' }] }, { servers: [{ name: '' }] }, { servers: [{ name: 'x', idleAlerts: 'no' }] }]) {
    fs.writeFileSync(file, JSON.stringify(bad));
    assert.throws(() => loadConfig(file), /config.servers/);
  }
  for (const bad of [42, 'prometheus:9090', 'ftp://x']) {
    fs.writeFileSync(file, JSON.stringify({ prometheusUrl: bad }));
    assert.throws(() => loadConfig(file), /prometheusUrl/);
  }
  fs.writeFileSync(file, JSON.stringify({ servers: [{ name: 'GPU Server 2' }], prometheusUrl: 'http://gpu-server-1:19090' }));
  assert.equal(loadConfig(file).prometheusUrl, 'http://gpu-server-1:19090');
});

test('Prometheus credentials come only from the environment', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ prometheusAuth: { username: 'from-file', password: 'x' } }));
  assert.deepEqual(loadConfig(file, {}).prometheusAuth, {});
  assert.deepEqual(loadConfig(file, { PROMETHEUS_USERNAME: 'nvtop', PROMETHEUS_PASSWORD: 'pw' }).prometheusAuth, { username: 'nvtop', password: 'pw' });
});
