class RollingBuffer {
  constructor({ historyMinutes = 5 } = {}) {
    this.historyMs = historyMinutes * 60_000;
    this.samples = []; // [{ timestamp, gpus }]
  }

  push(gpus, timestamp = Date.now()) {
    this.samples.push({ timestamp, gpus });
    const cutoff = timestamp - this.historyMs;
    while (this.samples.length && this.samples[0].timestamp < cutoff) {
      this.samples.shift();
    }
  }

  _utilizationsSince(sinceMs, now) {
    const values = [];
    for (const sample of this.samples) {
      if (sample.timestamp >= now - sinceMs) {
        for (const gpu of sample.gpus) values.push(gpu.utilization);
      }
    }
    return values;
  }

  getTrends(now = Date.now()) {
    const oneMin = this._utilizationsSince(60_000, now);
    const fiveMin = this._utilizationsSince(this.historyMs, now);
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    return {
      gpuAvgUtilization1m: avg(oneMin),
      gpuAvgUtilization5m: avg(fiveMin),
      gpuMaxUtilization5m: fiveMin.length ? Math.max(...fiveMin) : null,
    };
  }

  getHistory() {
    return this.samples.map(({ timestamp, gpus }) => ({
      timestamp,
      avgUtilization: gpus.length
        ? gpus.reduce((sum, g) => sum + g.utilization, 0) / gpus.length
        : 0,
    }));
  }
}

module.exports = { RollingBuffer };
