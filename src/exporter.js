const http = require('http');
const { loadExporterConfig } = require('./exporterConfig');
const { HostPoller } = require('./hostPoller');
const { renderMetrics } = require('./metrics');
const { createLocalRunner } = require('./localRunner');
const { createContainerLister } = require('./dockerApi');

// How long each result may be served before it is left out of /metrics.
function staleLimits(config) {
  return {
    gpuStaleMs: 5 * config.gpuPollIntervalMs,
    processesStaleMs: Math.max(60_000, 5 * config.gpuPollIntervalMs),
    diskStaleMs: 2 * config.diskPollIntervalMs + 60_000,
  };
}

function createMetricsServer(poller, limits) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method !== 'GET' || url.pathname !== '/metrics') {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('nvtop-exporter: see /metrics\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(renderMetrics(poller.snapshot(), limits));
  });
}

if (require.main === module) {
  const config = loadExporterConfig();
  const poller = new HostPoller(config, {
    run: createLocalRunner(),
    listContainers: config.dockerHost ? createContainerLister(config.dockerHost) : null,
  });
  poller.start();
  const server = createMetricsServer(poller, staleLimits(config));
  const shutdown = () => {
    poller.stop();
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  server.listen(config.listenPort, config.listenHost, () => {
    console.log(`nvtop-exporter listening on http://${config.listenHost}:${config.listenPort}/metrics`);
  });
}

module.exports = { createMetricsServer, staleLimits };
