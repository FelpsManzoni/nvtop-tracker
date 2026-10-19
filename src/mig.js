// Pure helpers turning the GPU list + latest MIG poll results into display entries.

function buildGpuEntries(gpus, migByGpu, utilByInstance, now, staleMs) {
  const out = [];
  for (const gpu of gpus) {
    const mig = migByGpu.get(gpu.id);
    if (gpu.utilization !== null || !mig || !mig.migEnabled || !mig.devices.length) {
      out.push({ ...gpu, mig: false });
      continue;
    }
    for (const d of [...mig.devices].sort((a, b) => a.migIndex - b.migIndex)) {
      const n = d.migIndex + 1;
      const u = utilByInstance.get(`${gpu.id}/${d.gpuInstanceId}`);
      const fresh = u && now - u.at <= staleMs;
      out.push({
        id: gpu.id,
        key: `${gpu.id}-${n}`,
        label: `GPU ${gpu.id} - ${n}`,
        name: gpu.name,
        mig: true,
        gpuInstanceId: d.gpuInstanceId,
        utilization: fresh ? Math.round(u.value * 1000) / 10 : null,
        memory: d.memory,
        temperature: gpu.temperature,
      });
    }
  }
  return out;
}

function buildGpuProcesses(baseProcesses, migByGpu) {
  const isMig = (id) => {
    const m = migByGpu.get(id);
    return !!(m && m.migEnabled && m.devices.length);
  };
  const rows = baseProcesses.filter((p) => !isMig(p.gpuId));
  for (const [gpuId, mig] of migByGpu) {
    if (!isMig(gpuId)) continue;
    for (const p of mig.processes) {
      const d = mig.devices.find((x) => x.gpuInstanceId === p.gpuInstanceId);
      if (!d) continue;
      const n = d.migIndex + 1;
      const { gpuInstanceId, ...rest } = p;
      rows.push({ gpuId, gpuKey: `${gpuId}-${n}`, gpuLabel: `GPU ${gpuId} - ${n}`, ...rest });
    }
  }
  return rows;
}

module.exports = { buildGpuEntries, buildGpuProcesses };
