const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createMetricsServer, staleLimits } = require('../src/exporter');
const { loadExporterConfig, DEFAULTS } = require('../src/exporterConfig');
const { createContainerLister } = require('../src/dockerApi');

const listen = (server, ...args) => new Promise((resolve) => server.listen(...args, () => resolve(server)));

test('/metrics renders the poller snapshot; anything else is 404', async () => {
  const at = Date.now();
  const poller = {
    snapshot: () => ({
      gpu: { ok: true, at, entries: [{ id: 0, key: '0', label: 'GPU 0', name: 'G', mig: false, utilization: 5, memory: { used: 1, total: 2 }, temperature: 30 }] },
      processes: { ok: null, at: null, list: [] },
      mig: { ok: null, at: null },
      disk: { ok: null, at: null, volumes: [] },
      containers: { ok: null, at: null, list: [] },
    }),
  };
  const server = await listen(createMetricsServer(poller, staleLimits(DEFAULTS)), 0, '127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/metrics`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/plain; version=0\.0\.4/);
    assert.match(await res.text(), /nvtop_gpu_utilization_percent\{key="0"\} 5/);
    assert.strictEqual((await fetch(`${base}/`)).status, 404);
  } finally {
    server.close();
  }
});

test('exporter config: defaults without a file, rejects bad values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-'));
  const file = path.join(dir, 'exporter.config.json');
  assert.deepEqual(loadExporterConfig(file), DEFAULTS);
  for (const bad of [{ diskMountPrefixes: 'data' }, { diskTopFolderMountPrefixes: ['data'] }, { listenPort: 0 }, { dockerHost: 'tcp://x:2375' }]) {
    fs.writeFileSync(file, JSON.stringify(bad));
    assert.throws(() => loadExporterConfig(file), /exporter config/);
  }
  fs.writeFileSync(file, JSON.stringify({ dockerHost: '', unifiedMemoryFallback: true }));
  assert.deepEqual([loadExporterConfig(file).dockerHost, loadExporterConfig(file).unifiedMemoryFallback], ['', true]);
});

test('the container lister sends only GET /containers/json over a unix socket and parses the answer', async () => {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dock-')), 'proxy.sock');
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ Names: ['/tracking-server'], State: 'running', Status: 'Up 2 hours', Created: 5 }]));
  });
  await listen(server, sock);
  try {
    assert.deepEqual(await createContainerLister(`unix://${sock}`)(), [{ name: 'tracking-server', status: 'Up 2 hours', created: 5 }]);
    assert.deepEqual(requests, ['GET /containers/json']);
  } finally {
    server.close();
  }
});

test('the container lister rejects a refused request (the proxy answers 403 to anything not allowed)', async () => {
  const server = await listen(http.createServer((req, res) => res.writeHead(403).end('forbidden')), 0, '127.0.0.1');
  try {
    await assert.rejects(createContainerLister(`http://127.0.0.1:${server.address().port}`)(), /HTTP 403/);
  } finally {
    server.close();
  }
});
