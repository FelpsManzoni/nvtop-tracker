#!/usr/bin/env node
// Compares the current (SSH) dashboard with the new (Prometheus) one on live data. Each round
// opens both, selects every server, waits for a fresh update on both pages, then captures what
// each page received (the `servers` map in public/app.js) and rendered, and checks them against
// scripts/parity/compare.js. Writes report.json, report.html and screenshots; exits 1 when an
// unexpected mismatch persisted.
//
//   OLD_URL=http://old-dashboard-host:3000 NEW_URL=http://gpu-server-1:13000 npm run parity
//
// Options (environment): PARITY_MINUTES (30), PARITY_INTERVAL_S (30), PARITY_ROUNDS (overrides
// the duration; 1 = quick check), PARITY_OUT (parity-report/<timestamp>), PARITY_SKIP_IDLE_TIME=1
// (when the boards don't share idle history yet).
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { compareServer, persistent, mismatchId } = require('./compare');

const env = process.env;
const OLD_URL = env.OLD_URL;
const NEW_URL = env.NEW_URL;
const INTERVAL_MS = Number(env.PARITY_INTERVAL_S || 30) * 1000;
const ROUNDS = Number(env.PARITY_ROUNDS) || Math.max(1, Math.round((Number(env.PARITY_MINUTES || 30) * 60_000) / INTERVAL_MS));
const SKIP_IDLE_TIME = env.PARITY_SKIP_IDLE_TIME === '1';
const OUT = env.PARITY_OUT || path.join('parity-report', new Date().toISOString().replace(/[:.]/g, '-'));

async function open(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(url);
  await page.waitForSelector('.server-card', { timeout: 30_000 });
  return page;
}

const serverNames = (page) => page.$$eval('.server-card', (els) => els.map((e) => e.dataset.name));

async function focus(page, name) {
  await page.evaluate((n) => [...document.querySelectorAll('.server-card')].find((e) => e.dataset.name === n).click(), name);
  await page.waitForFunction((n) => document.querySelector('.main-header h2')?.textContent === n, name);
}

// Resolves once the page has received (and rendered) an update newer than the current one.
async function waitFresh(page, name) {
  const before = await page.evaluate((n) => servers.get(n)?.receivedAt ?? 0, name);
  await page.waitForFunction(([n, t]) => (servers.get(n)?.receivedAt ?? 0) > t, [name, before], { timeout: 20_000 });
}

function capture(page, name) {
  return page.evaluate((n) => {
    const s = servers.get(n);
    const pill = (card) => {
      if (card.querySelector('.gpu-offline')) return { pill: 'offline' };
      const tag = card.querySelector('.gpu-tag');
      if (tag) return { pill: tag.textContent.trim() };
      const idle = card.querySelector('.gpu-idle');
      if (idle && idle.classList.contains('idle')) return { pill: 'idle', idleText: idle.textContent.replace('!', '').trim() };
      return { pill: 'in use' };
    };
    const cards = [...document.querySelectorAll('.gpu-graph-card')]
      .filter((c) => c.querySelector('.legend.util'))
      .map((c) => ({ label: c.querySelector('.gpu-graph-title').childNodes[0].textContent.trim(), ...pill(c) }));
    return {
      state: {
        connected: s.connected,
        error: s.error,
        gpu: s.gpu.map(({ key, label, mig, utilization, memory, temperature, unifiedMemory, lastIdleMs, idle30dMs }) => ({
          key, label, mig: !!mig, utilization, memory, temperature, unifiedMemory: !!unifiedMemory, lastIdleMs, idle30dMs,
        })),
        gpuProcesses: (s.gpuProcesses || []).map(({ gpuKey, pid, owner, fullCommand }) => ({ gpuKey, pid, owner, fullCommand })),
        docker: { containers: ((s.docker && s.docker.containers) || []).map(({ name }) => ({ name })) },
        disk: s.disk.map(({ mountpoint, usagePercent, topFolder }) => ({ mountpoint, usagePercent, topFolder })),
      },
      dom: {
        cards,
        processRows: document.querySelectorAll('.process-row').length,
        dockerRows: document.querySelectorAll('.docker-row').length,
        diskRows: document.querySelectorAll('.disk-row').length,
      },
    };
  }, name);
}

const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const show = (v) => escapeHtml(typeof v === 'string' ? v : JSON.stringify(v));

function writeReport(report) {
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const row = (m) => `<tr><td>${show(m.server)}</td><td>${show(m.item)}</td><td>${show(m.key)}</td><td>${show(m.old)}</td><td>${show(m.new)}</td><td>${show(m.rule)}</td></tr>`;
  const table = (rows) => (rows.length
    ? `<table><tr><th>Server</th><th>Item</th><th>Key</th><th>Current (SSH)</th><th>New (Prometheus)</th><th>Rule</th></tr>${rows.map(row).join('')}</table>`
    : '<p>None.</p>');
  const expected = [...new Map(report.rounds.flatMap((r) => r.mismatches).filter((m) => m.expected).map((m) => [mismatchId(m), m])).values()];
  const rounds = report.rounds.map((r, i) => `
    <details${r.mismatches.some((m) => !m.expected) ? ' open' : ''}><summary>Round ${i + 1} · ${escapeHtml(r.at)} · ${r.mismatches.filter((m) => !m.expected).length} unexpected</summary>
      ${table(r.mismatches.filter((m) => !m.expected))}
      ${r.shots.map((s) => `<h4>${escapeHtml(s.server)}</h4><div class="pair"><figure><img src="${s.old}"><figcaption>Current (SSH)</figcaption></figure><figure><img src="${s.new}"><figcaption>New (Prometheus)</figcaption></figure></div>`).join('')}
    </details>`).join('');
  fs.writeFileSync(path.join(OUT, 'report.html'), `<!doctype html><meta charset="utf-8"><title>Parity report</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;background:#fff;color:#1d1d1f}table{border-collapse:collapse;margin:8px 0 16px}td,th{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top}
.pass{color:#137333}.fail{color:#b3261e}.pair{display:flex;gap:12px}figure{margin:0;flex:1}img{width:100%;border:1px solid #ccc}</style>
<h1>Parity report: <span class="${report.passed ? 'pass' : 'fail'}">${report.passed ? 'passed' : 'failed'}</span></h1>
<p>${escapeHtml(report.oldUrl)} (current) vs ${escapeHtml(report.newUrl)} (new) · ${report.rounds.length} rounds every ${report.intervalS} s from ${escapeHtml(report.startedAt)}${report.skipIdleTime ? ' · idle times not compared' : ''}</p>
<h2>Unexpected mismatches that persisted two rounds</h2>${table(report.persistent)}
<h2>Expected differences</h2>${table(expected)}
<h2>Rounds</h2>${rounds}`);
}

async function main() {
  if (!OLD_URL || !NEW_URL) {
    console.error('Set OLD_URL (current SSH board) and NEW_URL (Prometheus board).');
    process.exit(2);
  }
  fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
  const browser = await chromium.launch();
  const report = { oldUrl: OLD_URL, newUrl: NEW_URL, startedAt: new Date().toISOString(), intervalS: INTERVAL_MS / 1000, skipIdleTime: SKIP_IDLE_TIME, rounds: [], persistent: [], passed: false };
  try {
    const [oldPage, newPage] = await Promise.all([open(browser, OLD_URL), open(browser, NEW_URL)]);
    for (let round = 1; round <= ROUNDS; round++) {
      const started = Date.now();
      const [oldNames, newNames] = await Promise.all([serverNames(oldPage), serverNames(newPage)]);
      const mismatches = [];
      if (oldNames.join() !== newNames.join()) {
        mismatches.push({ server: '', item: 'servers', key: '', old: oldNames, new: newNames, rule: 'same servers', expected: false });
      }
      const shots = [];
      for (const name of oldNames.filter((n) => newNames.includes(n))) {
        await Promise.all([focus(oldPage, name), focus(newPage, name)]);
        await Promise.all([waitFresh(oldPage, name), waitFresh(newPage, name)]);
        const [a, b] = await Promise.all([capture(oldPage, name), capture(newPage, name)]);
        mismatches.push(...compareServer(name, a, b, { skipIdleTime: SKIP_IDLE_TIME }));
        const base = `shots/r${String(round).padStart(3, '0')}-${name.replace(/[^\w-]+/g, '_')}`;
        await Promise.all([
          oldPage.screenshot({ path: path.join(OUT, `${base}-old.jpg`), type: 'jpeg', quality: 60 }),
          newPage.screenshot({ path: path.join(OUT, `${base}-new.jpg`), type: 'jpeg', quality: 60 }),
        ]);
        shots.push({ server: name, old: `${base}-old.jpg`, new: `${base}-new.jpg` });
      }
      report.rounds.push({ at: new Date().toISOString(), mismatches, shots });
      report.persistent = persistent(report.rounds.map((r) => r.mismatches), { intervalMs: INTERVAL_MS });
      report.passed = ROUNDS === 1 ? !mismatches.some((m) => !m.expected) : !report.persistent.length;
      writeReport(report);
      const unexpected = mismatches.filter((m) => !m.expected).length;
      console.log(`round ${round}/${ROUNDS}: ${unexpected} unexpected, ${mismatches.length - unexpected} expected, ${report.persistent.length} persistent`);
      if (round < ROUNDS) await new Promise((r) => setTimeout(r, Math.max(0, INTERVAL_MS - (Date.now() - started))));
    }
  } finally {
    await browser.close();
  }
  console.log(`${report.passed ? 'PASSED' : 'FAILED'} — ${path.resolve(OUT, 'report.html')}`);
  process.exit(report.passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
