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

  getHistoryByGpu() {
    const byGpu = {};
    for (const { timestamp, gpus } of this.samples) {
      for (const gpu of gpus) {
        if (!byGpu[gpu.id]) byGpu[gpu.id] = [];
        const memoryPercent = gpu.memory.total ? (gpu.memory.used / gpu.memory.total) * 100 : 0;
        byGpu[gpu.id].push({ timestamp, utilization: gpu.utilization, memoryPercent });
      }
    }
    return byGpu;
  }
}

module.exports = { RollingBuffer };
