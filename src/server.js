const express = require('express');
const path = require('path');
const { loadConfig } = require('./config');
const { Collector } = require('./collector');

const config = loadConfig();
const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

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
  app.listen(config.port, () => {
    console.log(`nvtop-tracker listening on http://localhost:${config.port}`);
    if (config.servers.length === 0) {
      console.log('No servers configured. Copy config.example.json to config.json and add your servers.');
    }
  });
}

module.exports = { app, collector };
