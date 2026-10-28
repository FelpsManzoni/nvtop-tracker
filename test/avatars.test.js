const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { avatarHandler } = require('../src/server');

test('/avatars serves only mapped users', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatars-'));
  fs.writeFileSync(path.join(dir, 'me.png'), 'PNG');
  const app = express();
  app.get('/avatars/:user', avatarHandler({ 'jsilva': 'me.png', ghost: 'missing.png' }, dir));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/avatars/`;
  try {
    const ok = await fetch(`${base}jsilva`);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(await ok.text(), 'PNG');
    assert.strictEqual((await fetch(`${base}nobody`)).status, 404);
    assert.strictEqual((await fetch(`${base}ghost`)).status, 404);
    assert.strictEqual((await fetch(`${base}..%2Fme.png`)).status, 404);
    assert.strictEqual((await fetch(`${base}toString`)).status, 404);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true });
  }
});
