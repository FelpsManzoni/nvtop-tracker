const http = require('http');
const { parseDockerContainersJson } = require('./parsers');

// Lists running containers through the Docker Engine API. `dockerHost` is unix:///path/to.sock
// (the Docker socket, or in production a socket proxy that only allows this one request) or
// http://host:port. Only GET /containers/json is ever sent.
function createContainerLister(dockerHost, { timeoutMs = 10000 } = {}) {
  const target = dockerHost.startsWith('unix://')
    ? { socketPath: dockerHost.slice('unix://'.length) }
    : (({ hostname, port }) => ({ host: hostname, port }))(new URL(dockerHost));
  return () =>
    new Promise((resolve, reject) => {
      const req = http.get({ ...target, path: '/containers/json', timeout: timeoutMs }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`docker api: HTTP ${res.statusCode}`));
          try {
            resolve(parseDockerContainersJson(body));
          } catch (err) {
            reject(new Error(`docker api: ${err.message}`));
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('docker api: timeout')));
      req.on('error', reject);
    });
}

module.exports = { createContainerLister };
