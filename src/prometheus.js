// Minimal Prometheus HTTP API client. Credentials only go into the Authorization header; errors
// never include them (the same care teams.js takes with the webhook URL).
class PrometheusClient {
  constructor({ url, username, password, fetchFn = fetch, timeoutMs = 5000 }) {
    this.base = url.replace(/\/+$/, '');
    this.fetchFn = fetchFn;
    this.timeoutMs = timeoutMs;
    this.headers = username ? { Authorization: `Basic ${Buffer.from(`${username}:${password || ''}`).toString('base64')}` } : {};
  }

  async _get(path, params) {
    let res;
    try {
      res = await this.fetchFn(`${this.base}${path}?${new URLSearchParams(params)}`, {
        headers: this.headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const kind = err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : 'network error';
      throw new Error(`prometheus: request failed (${kind})`);
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON error page
    }
    if (!res.ok || !body || body.status !== 'success') {
      throw new Error(`prometheus: HTTP ${res.status}${body && body.error ? ` (${String(body.error).slice(0, 200)})` : ''}`);
    }
    return body.data;
  }

  // Instant query. Returns the evaluation time (ms, Prometheus' clock) and each series' labels and value.
  async query(expr) {
    const requestedAt = Date.now();
    const data = await this._get('/api/v1/query', { query: expr });
    const result = data.result || [];
    const time = result.length ? Math.round(result[0].value[0] * 1000) : requestedAt;
    return { time, series: result.map((r) => ({ labels: r.metric, value: Number(r.value[1]) })) };
  }

  // Range query. Returns each series' labels and its [ms, value] points.
  async queryRange(expr, startMs, endMs, stepMs) {
    const data = await this._get('/api/v1/query_range', {
      query: expr,
      start: String(startMs / 1000),
      end: String(endMs / 1000),
      step: `${stepMs / 1000}s`,
    });
    return (data.result || []).map((r) => ({
      labels: r.metric,
      points: r.values.map(([t, v]) => [Math.round(t * 1000), Number(v)]),
    }));
  }
}

module.exports = { PrometheusClient };
