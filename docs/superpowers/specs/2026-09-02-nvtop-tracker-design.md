# nvtop Tracker: Multi-Server GPU & Disk Monitoring

**Date:** 2026-09-02  
**Status:** Design Approved  
**Scope:** Localhost web app for observing GPU and disk metrics across 3-5 servers

---

## Executive Summary

A lightweight web-based monitoring dashboard that displays real-time GPU utilization, memory, temperature, and disk usage across multiple servers via SSH. Data is collected every 1-5 seconds for GPU metrics and every 5 minutes for disk usage. The frontend displays a focused view of one server plus sidebar summaries of all servers, with automatic updates via Server-Sent Events (SSE). No persistent history; strictly for observation and capacity planning.

---

## Requirements

### Functional Requirements
1. **Multi-server monitoring:** Track 3-5 servers simultaneously via SSH
2. **GPU metrics:** Utilization, memory usage, temperature for each GPU (collected every 1-5 seconds)
3. **Rolling 5-minute GPU history:** Compute trends (min/max/avg) over the last 5 minutes
4. **Disk monitoring:** Per-volume usage snapshot every 5 minutes
5. **Storage alerting:** Flag volumes exceeding configurable threshold (default 85%)
6. **Two-view UI:**
   - Sidebar: small summary cards for all servers (quick overview)
   - Main area: detailed focused view of one selected server
7. **Real-time updates:** No manual page refresh; data updates as collected
8. **SSH authentication:** Use existing `~/.ssh/config` and keys; no additional auth required

### Non-Functional Requirements
- **Scope:** Localhost only; single user; no persistent database
- **Technology:** Node.js backend, vanilla JS frontend, SSE for streaming
- **Deployment:** Single command startup (`npm start`)
- **Resilience:** Handle server disconnects gracefully; retry and mark unreachable; resume on reconnect
- **Data:** In-memory only; history cleared on server restart

---

## Architecture

### Components

**Backend (Node.js + Express):**
- HTTP server on localhost (port 3000, configurable)
- Reads `config.json` for server list
- Maintains persistent SSH connections to each configured server
- **GPU collection task:** Every N ms (1000-5000), run `nvtop` on each server, parse GPU metrics, maintain rolling 5-minute buffer
- **Disk collection task:** Every M ms (default 300000 = 5 min), run `df` on each server, parse usage
- **SSE endpoint:** `/stream` streams all collected data to connected clients

**Frontend (Vanilla HTML/CSS/JS):**
- Single-page app served from backend
- Connects to SSE endpoint, receives real-time updates
- Two-pane layout:
  - Left sidebar: server summary cards (clickable to focus)
  - Main area: focused server detail view with GPU breakdown, graphs, disk usage

### Data Flow

```
Config → Backend (Node.js)
         ↓
    [SSH Connections]
         ↓
    GPU Collection (every 1-5s) → Rolling Buffer (5 min)
    Disk Collection (every 5min) ↓
         ↓
    [SSE Stream]
         ↓
    Frontend (Browser)
         ↓
    UI Render (real-time, no refresh)
```

---

## Configuration

Users create `config.json` in the project root:

```json
{
  "servers": [
    {
      "name": "GPU Server 1",
      "host": "gpu-server-1.local",
      "user": "myuser"
    },
    {
      "name": "GPU Server 2",
      "host": "gpu-server-2.local",
      "user": "myuser"
    }
  ],
  "gpuPollIntervalMs": 2000,
  "diskPollIntervalMs": 300000,
  "gpuHistoryMinutes": 5,
  "diskStorageAlertThreshold": 85,
  "sshRetryMaxAttempts": 3,
  "sshRetryDelayMs": 5000
}
```

**Fields:**
- `servers`: Array of server configs (host, user via SSH)
- `gpuPollIntervalMs`: GPU collection interval (1000-5000 ms)
- `diskPollIntervalMs`: Disk check interval (default 300000 = 5 min)
- `gpuHistoryMinutes`: Rolling window for GPU data (5 min)
- `diskStorageAlertThreshold`: Alert threshold (0-100 %)
- `sshRetryMaxAttempts`: Retries on connection failure
- `sshRetryDelayMs`: Delay between retries (exponential backoff)

SSH authentication uses existing `~/.ssh/config` keys (no credentials in config).

---

## Backend Design

### SSH & Data Collection

**GPU Collection:**
- Every `gpuPollIntervalMs`, run `nvtop -1 -c -o csv` (or compatible) on each server
- Parse output: extract GPU id, utilization %, memory usage, temperature
- Store in rolling buffer keyed by server + GPU id
- Discard data older than `gpuHistoryMinutes`
- Compute trends: min, max, average utilization over last 1 min / 5 min

**Disk Collection:**
- Every `diskPollIntervalMs`, run `df -h` on each server
- Parse mounted volumes: filesystem, size, used, available, use %
- Check if any volume exceeds `diskStorageAlertThreshold`; flag alert if true
- Store latest snapshot (no history)

### Error Handling

- **SSH Connection Failure:**
  - Retry up to `sshRetryMaxAttempts` with exponential backoff
  - After max retries, mark server as "unreachable"
  - Continue retrying in background
  - When connection restores, send updated data to all clients

- **Command Execution Failure:**
  - Log error, skip this collection cycle
  - Mark metric as "unavailable" in stream
  - Retry on next cycle

- **Malformed Output:**
  - Log error, skip affected GPU/disk entry
  - Other metrics remain valid

### SSE Streaming

**Endpoint:** `GET /stream`

**Message Format (JSON):**
```json
{
  "server": "GPU Server 1",
  "timestamp": 1693564800000,
  "connected": true,
  "gpu": [
    {
      "id": 0,
      "utilization": 85,
      "memory": { "used": 7500, "total": 8000 },
      "temperature": 65
    }
  ],
  "disk": [
    {
      "filesystem": "/dev/sda1",
      "mountpoint": "/",
      "used": 450,
      "total": 500,
      "usagePercent": 90,
      "alert": true
    }
  ],
  "trends": {
    "gpuAvgUtilization1m": 82,
    "gpuAvgUtilization5m": 75,
    "gpuMaxUtilization5m": 95
  }
}
```

**Client Connection:**
- Browser opens SSE connection on page load
- Backend sends updates for all servers in real-time
- Connection auto-reconnects on drop

---

## Frontend Design

### Layout

**Left Sidebar (120px wide, scrollable):**
- Title: "Servers"
- List of server cards:
  - Server name (bold)
  - GPU status: "6/8 in use" or "avg: 75%"
  - Disk status: green/yellow/red indicator + usage % (e.g., "78%")
  - Connection badge: "●" green if online, red if unreachable
  - Click to focus that server

**Main Area (full width minus sidebar):**
- **Header:**
  - Focused server name + connection status
  - Last updated timestamp
  
- **GPU Section:**
  - GPU breakdown: table or list showing each GPU
    - GPU id, utilization %, memory used/total, temperature
  - Utilization trend graph: 5-minute rolling line chart
    - X-axis: time (0-5 min ago)
    - Y-axis: utilization %
    - One line per GPU or aggregate
  
- **Disk Section:**
  - Volume list with usage bars:
    - Filesystem, mountpoint, used/total, usage %
    - Red bar if above alert threshold
  - Alert badge if any volume flagged

### Behavior

- On page load: SSE auto-connects, displays all servers
- First server in config is focused by default
- Clicking a sidebar card switches focused server
- Data updates flow in real-time without page refresh
- Graphs scroll left as new data arrives, keeping 5 min visible
- Unreachable badge appears on server disconnect, clears on reconnect
- Last-known data remains visible during unreachable state

---

## Technology Stack

**Backend:**
- Node.js 18+
- Express.js (HTTP server, SSE streaming)
- ssh2 (SSH connections)

**Frontend:**
- Vanilla HTML/CSS/JS (no frameworks)
- Server-Sent Events API (native browser support)
- Simple SVG or Canvas for trend graphs

**Deployment:**
- npm start (single command)
- No Docker or external services required
- Port 3000 (configurable)

---

## Assumptions & Constraints

### Assumptions
1. All servers have `nvtop` installed and accessible by the SSH user
2. All servers have `df` command available
3. SSH keys are pre-configured in `~/.ssh/config`
4. Local machine can reach all servers via SSH
5. Modern browser (supports SSE, fetch API, ES6)

### Constraints
1. **Localhost only:** No remote access (can be proxied if needed later)
2. **No persistent storage:** Data cleared on server restart
3. **In-memory buffer:** Limited to 5 min of GPU data; no backfill for missed cycles
4. **SSH retry:** If a server is offline long-term, retries eventually back off
5. **Single user:** No multi-user sessions or authentication

### Known Limitations
1. GPU metrics depend on nvtop format; may need adjustment for different GPU types
2. No alerting system (only visual badges); alerts don't persist
3. No export or logging; data is ephemeral

---

## Error Scenarios & Recovery

| Scenario | Behavior |
|----------|----------|
| Server SSH unreachable | Retry with backoff; mark unreachable; last data visible on UI |
| Server comes back online | Automatic reconnect; resume streaming |
| nvtop not installed on server | Log error; show "metric unavailable" |
| Disk > alert threshold | Red badge + alert flag in stream |
| Browser tab closes | SSE connection drops; no data sent; other clients unaffected |
| Backend crashes | Restart with `npm start`; data lost; browser reconnects |

---

## Success Criteria

1. ✓ Display real-time GPU and disk metrics from 3-5 servers
2. ✓ Two-view UI: focused detail + sidebar summaries
3. ✓ No manual page refresh; automatic SSE updates
4. ✓ Handle server disconnects gracefully
5. ✓ Simple startup: `npm start` + open browser
6. ✓ Configuration via JSON file

---

## Future Enhancements (Out of Scope)

- Persistent database for historical trending
- Remote access (HTTPS, reverse proxy)
- Alerting system (email, Slack, webhook)
- Multi-user authentication
- GPU process breakdown (which apps use GPU)
- Custom alert rules
