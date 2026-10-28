const { test } = require('node:test');
const assert = require('node:assert');
const { PrometheusClient } = require('../src/prometheus');

const ok = (data) => ({ ok: true, status: 200, json: async () => ({ status: 'success', data }) });

test('query sends basic auth, returns the evaluation time and the series', async () => {
  const calls = [];
  const client = new PrometheusClient({
    url: 'http://prom:19090/',
    username: 'nvtop',
    password: 's3cret',
    fetchFn: async (url, opts) => {
      calls.push({ url, opts });
      return ok({ resultType: 'vector', result: [{ metric: { __name__: 'nvtop_gpu_info', server: 'GPU Server 2' }, value: [1800000000.5, '1'] }] });
    },
  });
  const r = await client.query('{__name__=~"nvtop_.+"}');
  assert.deepEqual(r, { time: 1800000000500, series: [{ labels: { __name__: 'nvtop_gpu_info', server: 'GPU Server 2' }, value: 1 }] });
  assert.strictEqual(calls[0].url, 'http://prom:19090/api/v1/query?query=%7B__name__%3D%7E%22nvtop_.%2B%22%7D');
  assert.strictEqual(calls[0].opts.headers.Authorization, `Basic ${Buffer.from('nvtop:s3cret').toString('base64')}`);
});

test('queryRange passes start/end/step in seconds and returns points in ms', async () => {
  let url;
  const client = new PrometheusClient({
    url: 'http://prom:19090',
    fetchFn: async (u) => {
      url = new URL(u);
      return ok({ resultType: 'matrix', result: [{ metric: { key: '0' }, values: [[1800000000, '5'], [1800000002, '7']] }] });
    },
  });
  const r = await client.queryRange('up', 1_800_000_000_000, 1_800_000_300_000, 2000);
  assert.deepEqual([url.searchParams.get('start'), url.searchParams.get('end'), url.searchParams.get('step')], ['1800000000', '1800000300', '2s']);
  assert.deepEqual(r, [{ labels: { key: '0' }, points: [[1800000000000, 5], [1800000002000, 7]] }]);
});

test('errors never carry the credentials', async () => {
  const secret = 'pa55word';
  const failing = [
    async () => { throw new Error(`connect ECONNREFUSED http://nvtop:${secret}@prom`); },
    async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; },
    async () => ({ ok: false, status: 401, json: async () => { throw new Error('not json'); } }),
    async () => ({ ok: false, status: 400, json: async () => ({ status: 'error', error: 'parse error' }) }),
  ];
  const messages = [];
  for (const fetchFn of failing) {
    const client = new PrometheusClient({ url: 'http://prom:19090', username: 'nvtop', password: secret, fetchFn });
    await assert.rejects(client.query('up'), (err) => { messages.push(err.message); return true; });
  }
  assert.deepEqual(messages, [
    'prometheus: request failed (network error)',
    'prometheus: request failed (timeout)',
    'prometheus: HTTP 401',
    'prometheus: HTTP 400 (parse error)',
  ]);
});

test('no Authorization header without a username', async () => {
  let headers;
  const client = new PrometheusClient({ url: 'http://prom', fetchFn: async (u, o) => { headers = o.headers; return ok({ result: [] }); } });
  const r = await client.query('up');
  assert.deepEqual(headers, {});
  assert.deepEqual(r.series, []);
});
