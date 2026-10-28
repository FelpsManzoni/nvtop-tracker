# Two images from one Dockerfile: the dashboard (--target dashboard) and the per-host exporter
# (--target exporter). nvidia-smi comes from the NVIDIA container runtime and dcgmi from the host
# (see deploy/common.sh); nothing else is needed on the GPU servers.
FROM node:24.22.1-bookworm-slim AS base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

FROM base AS exporter
# ps (procps) finds process owners; df, du and timeout come with coreutils.
RUN apt-get update \
 && apt-get install -y --no-install-recommends procps \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production NVTOP_EXPORTER_CONFIG=/config/exporter.config.json
CMD ["node", "src/exporter.js"]

FROM base AS dashboard
COPY public ./public
ENV NODE_ENV=production NVTOP_CONFIG=/config/config.json
USER node
CMD ["node", "src/server.js"]
