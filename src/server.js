const express = require('express');
const path = require('path');
const { loadConfig } = require('./config');
const { Collector } = require('./collector');

const config = loadConfig();
const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

// Only files explicitly mapped in config.userAvatars are served; the request never
// contributes to the filesystem path, so there's nothing to traverse.
function avatarHandler(userAvatars, rootDir = path.join(__dirname, '..')) {
  return (req, res) => {
    if (!Object.hasOwn(userAvatars, req.params.user)) return res.sendStatus(404);
    res.sendFile(path.resolve(rootDir, userAvatars[req.params.user]), { maxAge: '1h' }, (err) => {
      if (err && !res.headersSent) res.sendStatus(404);
    });
  };
}
app.get('/avatars/:user', avatarHandler(config.userAvatars));

const collector = new Collector(config);
const clients = new Set();

app.get('/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  clients.add(res);

  for (const state of collector.getSnapshot()) {
    res.write(`data: ${JSON.stringify(state)}\n\n`);
  }

  req.on('close', () => clients.delete(res));
});

collector.on('update', (state) => {
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) res.write(payload);
});

if (require.main === module) {
  collector.start();
  // systemd stops/restarts send SIGTERM; save idle history before exiting so nothing is lost.
  const shutdown = () => {
    collector.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  app.listen(config.port, () => {
    console.log(`nvtop-tracker listening on http://localhost:${config.port}`);
    if (config.servers.length === 0) {
      console.log('No servers configured. Copy config.example.json to config.json and add your servers.');
    }
  });
}

module.exports = { app, collector, avatarHandler };
