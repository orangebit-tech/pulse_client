const http = require('http');
const { execFile } = require('child_process');
const { io } = require('socket.io-client');
const si = require('systeminformation');
const os = require('os');
const axios = require('axios');
console.log("[CLIENT] Pulse client starting...");
require('dotenv').config();

// Update here

function readNonNegativeInt(name, fallback) {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = url.username ? '<redacted>' : '';
      url.password = url.password ? '<redacted>' : '';
    }
    return url.toString();
  } catch {
    return value || '<unset>';
  }
}

const INSTANCE_TYPE = process.env.INSTANCE_TYPE || 'web-server';
const domain = process.env.DOMAIN || 'localhost';
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT, 10) || 9443;
const ENABLE_CERT_CHECK = process.env.ENABLE_CERT_CHECK === 'true';
const masterUrl = process.env.MASTER_URL;
const HOST_REG_TOKEN = process.env.HOST_REG_TOKEN;
const HOST_KEY = process.env.HOST_KEY || `${os.hostname()}-${INSTANCE_TYPE}`;
const METRICS_INTERVAL_MS = parseInt(process.env.METRICS_INTERVAL_MS, 10) || 10000;
const INCLUDE_DOCKER_CONTAINERS = process.env.INCLUDE_DOCKER_CONTAINERS === 'true';
const DOCKER_CONTAINERS_LIMIT = parseInt(process.env.DOCKER_CONTAINERS_LIMIT || '20', 10);
const DOCKER_CONTAINERS_INTERVAL_MS = parseInt(
  process.env.DOCKER_CONTAINERS_INTERVAL_MS || '60000',
  10,
);
const INCLUDE_PROCESSES = process.env.INCLUDE_PROCESSES !== 'false';
const PROCESSES_LIMIT = readNonNegativeInt('PROCESSES_LIMIT', 50);
const NODE_PROCESSES_LIMIT = readNonNegativeInt('NODE_PROCESSES_LIMIT', 50);
const PROCESSES_INTERVAL_MS = readNonNegativeInt('PROCESSES_INTERVAL_MS', 30000);
const PROCESS_COMMAND_MAX_LENGTH = readNonNegativeInt('PROCESS_COMMAND_MAX_LENGTH', 240);
let dockerContainersLogged = false;
let lastDockerContainers = null;
let lastDockerContainersHash = null;
let lastDockerContainersAt = 0;
let processesLogged = false;
let lastProcesses = null;
let lastProcessesHash = null;
let lastNodeProcesses = null;
let lastNodeProcessesHash = null;
let lastProcessesAt = 0;
let lastProcessSummary = null;


let latestMetrics = {};
let clientIP = '0.0.0.0';
let certExpiration = null;
let isHttpsReachable = false;
let metricsEmitLogged = false;

// Fetch IP once
async function fetchClientIP() {
  try {
    const response = await axios.get('https://api64.ipify.org?format=json');
    clientIP = response.data.ip;
    console.log("Got client IP:", clientIP);
  } catch (err) {
    console.error("Failed to fetch IP:", err.message);
  }
}

async function checkMasterCertificate() {
  return new Promise((resolve, reject) => {
    console.log(`[CLIENT] Checking master certificate at ${domain}`);
    const https = require('https'); 
    const req = https.request({
      hostname: domain,
      port: 443,
      method: 'GET',
    }, (res) => {
      const cert = res.socket?.getPeerCertificate?.();
      if (cert && cert.valid_to) {
        certExpiration = cert.valid_to;
        isHttpsReachable = true;
        console.log(`[CERT] Master cert valid until: ${certExpiration}`);
      } else {
        console.warn('[WARN] No certificate info found');
      }
      resolve();
    });

    req.on('error', (err) => {
      console.error(`[ERROR] Certificate check failed: ${err.message}`);
      resolve(); // proceed without crashing
    });
    console.log(`[CLIENT] Finished checking master certificate at ${domain}:443`);
    req.end();
  });
}
let stackInfo = null;

async function collectStackInfo() {
  const osInfo = await si.osInfo();
  let dockerVersion = null;
  try {
    const dockerInfo = await si.dockerInfo();
    dockerVersion = dockerInfo.serverVersion || dockerInfo.version || null;
  } catch (err) {
    console.warn('[CLIENT] Docker info unavailable:', err.message);
  }

  const rawOs = osInfo.distro || osInfo.platform || os.type();
  return {
    os: String(rawOs || 'unknown').toLowerCase(),
    osVersion: osInfo.release || osInfo.version || null,
    nodeVersion: process.versions.node || process.version,
    dockerVersion,
    name: osInfo.distro ? `${osInfo.distro} ${osInfo.release || ''}`.trim() : null,
  };
}

function truncate(value, maxLength) {
  if (typeof value !== 'string') {
    return value ?? null;
  }
  if (maxLength <= 0 || value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

function parsePort(value) {
  const port = parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function addPort(portMap, pid, port) {
  const parsedPid = parseInt(pid, 10);
  const parsedPort = parsePort(port);
  if (!Number.isInteger(parsedPid) || parsedPid <= 0 || parsedPort == null) {
    return;
  }
  if (!portMap.has(parsedPid)) {
    portMap.set(parsedPid, new Set());
  }
  portMap.get(parsedPid).add(parsedPort);
}

function sortPortMap(portMap) {
  const sorted = new Map();
  for (const [pid, ports] of portMap.entries()) {
    sorted.set(pid, Array.from(ports).sort((left, right) => left - right));
  }
  return sorted;
}

function getEndpointPort(endpoint) {
  if (typeof endpoint !== 'string') {
    return null;
  }
  const match = endpoint.match(/:(\d+)$/);
  return match ? match[1] : null;
}

function execFileOutput(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.toString());
    });
  });
}

function parseSsListeningPorts(stdout) {
  const portMap = new Map();
  stdout.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('LISTEN')) {
      return;
    }
    const parts = trimmed.replace(/ +/g, ' ').split(' ');
    const pidMatch = trimmed.match(/pid=(\d+)/);
    if (!pidMatch || parts.length < 4) {
      return;
    }
    addPort(portMap, pidMatch[1], getEndpointPort(parts[3]));
  });
  return portMap;
}

function parseNetstatListeningPorts(stdout) {
  const portMap = new Map();
  stdout.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || !/^tcp/i.test(trimmed)) {
      return;
    }
    const parts = trimmed.replace(/ +/g, ' ').split(' ');
    if (parts.length < 7 || parts[5] !== 'LISTEN') {
      return;
    }
    const pid = parts[6].split('/')[0];
    addPort(portMap, pid, getEndpointPort(parts[3]));
  });
  return portMap;
}

async function collectLinuxListeningPortsFallback() {
  try {
    return parseSsListeningPorts(await execFileOutput('ss', ['-ltnp']));
  } catch (ssErr) {
    try {
      return parseNetstatListeningPorts(await execFileOutput('netstat', ['-ltnp']));
    } catch (netstatErr) {
      console.warn(
        `[CLIENT] Linux listening port fallback unavailable: ss=${ssErr.message}; netstat=${netstatErr.message}`,
      );
      return new Map();
    }
  }
}

async function collectListeningPortsByPid() {
  try {
    const connections = await si.networkConnections();
    const portMap = new Map();
    connections
      .filter((connection) => {
        const protocol = String(connection.protocol || '').toLowerCase();
        const state = String(connection.state || '').toUpperCase();
        return protocol.startsWith('tcp') && state === 'LISTEN';
      })
      .forEach((connection) => addPort(portMap, connection.pid, connection.localPort));

    if (portMap.size === 0 && os.platform() === 'linux') {
      return sortPortMap(await collectLinuxListeningPortsFallback());
    }

    return sortPortMap(portMap);
  } catch (err) {
    console.warn('[CLIENT] systeminformation listening ports unavailable:', err.message);
    if (os.platform() === 'linux') {
      return sortPortMap(await collectLinuxListeningPortsFallback());
    }
    return new Map();
  }
}

function normalizeProcess(proc, portsByPid) {
  return {
    pid: proc.pid,
    parentPid: proc.parentPid ?? proc.ppid ?? null,
    name: proc.name || null,
    command: truncate(proc.command || proc.params || null, PROCESS_COMMAND_MAX_LENGTH),
    user: proc.user || null,
    state: proc.state || null,
    started: proc.started || null,
    cpu: Number.isFinite(proc.cpu) ? proc.cpu : 0,
    memory: Number.isFinite(proc.mem) ? proc.mem : 0,
    priority: proc.priority ?? null,
    ports: portsByPid.get(proc.pid) || [],
  };
}

function sortProcessesForMonitoring(processes) {
  return processes.sort((left, right) => {
    const portDelta = (right.ports.length > 0 ? 1 : 0) - (left.ports.length > 0 ? 1 : 0);
    if (portDelta !== 0) {
      return portDelta;
    }
    const cpuDelta = (right.cpu || 0) - (left.cpu || 0);
    if (cpuDelta !== 0) {
      return cpuDelta;
    }
    return (right.memory || 0) - (left.memory || 0);
  });
}

function isNodeProcess(proc) {
  const name = String(proc.name || '').toLowerCase();
  if (name === 'node' || name === 'nodejs' || name === 'node.exe') {
    return true;
  }

  const command = String(proc.command || '').toLowerCase();
  return /(^|[\s"'=:/\\])(node|nodejs)(\.exe)?($|[\s"'/:\\.-])/.test(command);
}

async function collectProcessMetrics() {
  if (!INCLUDE_PROCESSES) {
    return {
      summary: null,
      payload: null,
      nodeSummary: null,
      nodePayload: null,
    };
  }

  const now = Date.now();
  if (lastProcessesAt && now - lastProcessesAt < PROCESSES_INTERVAL_MS) {
    return {
      summary: lastProcessSummary,
      payload: lastProcessesHash ? { same: true } : null,
      nodeSummary: lastProcessSummary?.node ?? null,
      nodePayload: lastNodeProcessesHash ? { same: true } : null,
    };
  }

  try {
    const processInfo = await si.processes();
    const portsByPid = await collectListeningPortsByPid();
    const rawList = Array.isArray(processInfo.list) ? processInfo.list : [];
    const limit = Math.max(PROCESSES_LIMIT, 0);
    const nodeLimit = Math.max(NODE_PROCESSES_LIMIT, 0);
    const normalizedFullList = rawList
      .filter((proc) => proc.pid !== 0)
      .map((proc) => normalizeProcess(proc, portsByPid));
    const normalized = sortProcessesForMonitoring([...normalizedFullList]).slice(0, limit);
    const nodeProcessesFullList = normalizedFullList.filter(isNodeProcess);
    const nodeProcesses = sortProcessesForMonitoring([...nodeProcessesFullList]).slice(0, nodeLimit);

    const summary = {
      total: processInfo.all ?? rawList.length,
      running: processInfo.running ?? null,
      blocked: processInfo.blocked ?? null,
      sleeping: processInfo.sleeping ?? null,
      unknown: processInfo.unknown ?? null,
      listed: normalized.length,
      limit,
      sampledAt: now,
      node: {
        total: nodeProcessesFullList.length,
        listed: nodeProcesses.length,
        limit: nodeLimit,
        sampledAt: now,
      },
    };
    console.log('[CLIENT] Process query result:', JSON.stringify({
      summary,
      processes: normalized,
      nodeProcesses,
    }, null, 2));
    const nextHash = JSON.stringify(normalized);
    const nextNodeHash = JSON.stringify(nodeProcesses);
    lastProcessSummary = summary;
    lastProcessesAt = now;

    const processesChanged = nextHash !== lastProcessesHash;
    const nodeProcessesChanged = nextNodeHash !== lastNodeProcessesHash;
    if (processesChanged) {
      lastProcesses = normalized;
      lastProcessesHash = nextHash;
    }
    if (nodeProcessesChanged) {
      lastNodeProcesses = nodeProcesses;
      lastNodeProcessesHash = nextNodeHash;
    }
    if (!processesLogged) {
      processesLogged = true;
      console.log(`[CLIENT] Processes collected: ${normalized.length}/${summary.total} (limit ${limit})`);
      console.log(
        `[CLIENT] Node processes collected: ${nodeProcesses.length}/${summary.node.total} (limit ${nodeLimit})`,
      );
      if (normalized.length === 0) {
        console.warn('[CLIENT] Process list is empty');
      }
    }

    return {
      summary,
      payload: processesChanged ? normalized : { same: true },
      nodeSummary: summary.node,
      nodePayload: nodeProcessesChanged ? nodeProcesses : { same: true },
    };
  } catch (err) {
    console.warn('[CLIENT] Processes unavailable:', err.message);
    return {
      summary: lastProcessSummary,
      payload: lastProcessesHash ? { same: true } : null,
      nodeSummary: lastProcessSummary?.node ?? null,
      nodePayload: lastNodeProcessesHash ? { same: true } : null,
    };
  }
}

async function collectMetrics() {
  const uptime = os.uptime();
  const netStats = await si.networkStats();
  const tx = netStats[0]?.tx_bytes || 0;
  const rx = netStats[0]?.rx_bytes || 0;
  const mem = await si.mem();
  const cpu = await si.currentLoad();
  const disks = await si.fsSize();
  const ioStats = (await si.disksIO()) || {};
  const disk = disks[0] || {};
  let docker = null;
  try {
    docker = await si.dockerInfo();
  } catch (err) {
    console.warn('[CLIENT] Docker info unavailable:', err.message);
  }
  let dockerContainers = null;
  let dockerContainersPayload = null;
  if (INCLUDE_DOCKER_CONTAINERS) {
    try {
      const now = Date.now();
      if (now - lastDockerContainersAt >= DOCKER_CONTAINERS_INTERVAL_MS) {
        const containers = await si.dockerContainers();
        const normalized = containers
          .slice(0, Math.max(DOCKER_CONTAINERS_LIMIT, 0))
          .map((container) => ({
            id: container.id,
            name: container.name,
            image: container.image,
            state: container.state,
            status: container.status,
            ports: container.ports,
          }));
        const nextHash = JSON.stringify(normalized);
        if (nextHash !== lastDockerContainersHash) {
          dockerContainers = normalized;
          dockerContainersPayload = normalized;
          lastDockerContainers = normalized;
          lastDockerContainersHash = nextHash;
          lastDockerContainersAt = now;
          if (!dockerContainersLogged) {
            dockerContainersLogged = true;
            console.log(
              `[CLIENT] Docker containers collected: ${dockerContainers.length} (limit ${DOCKER_CONTAINERS_LIMIT})`,
            );
            if (dockerContainers.length === 0) {
              console.warn('[CLIENT] Docker containers list is empty');
            }
          }
        } else {
          dockerContainersPayload = { same: true };
          lastDockerContainersAt = now;
        }
      } else if (lastDockerContainersHash) {
        dockerContainersPayload = { same: true };
      }
    } catch (err) {
      console.warn('[CLIENT] Docker containers unavailable:', err.message);
    }
  }
  const processMetrics = await collectProcessMetrics();

  return {
    cpuLoad: cpu.currentLoad,
    totalMem: os.totalmem(),
    freeMem: os.freemem(),
    swpMem: mem.swapused,
    totalSwpMem: mem.swaptotal,
    totalDisk: disk.size || 0,
    freeDisk: disk.available || 0,
    diskReads: ioStats.rIO || 0,
    diskWrites: ioStats.wIO || 0,
    uptime,
    netTx: tx,
    netRx: rx,
    dockerContainersTotal: docker?.containers ?? null,
    dockerContainersRunning: docker?.containersRunning ?? null,
    dockerContainersPaused: docker?.containersPaused ?? null,
    dockerContainersStopped: docker?.containersStopped ?? null,
    dockerContainers: dockerContainersPayload ?? dockerContainers,
    processesTotal: processMetrics.summary?.total ?? null,
    processesRunning: processMetrics.summary?.running ?? null,
    processesBlocked: processMetrics.summary?.blocked ?? null,
    processesSleeping: processMetrics.summary?.sleeping ?? null,
    processesUnknown: processMetrics.summary?.unknown ?? null,
    processesListed: processMetrics.summary?.listed ?? null,
    processesLimit: processMetrics.summary?.limit ?? null,
    processesSampledAt: processMetrics.summary?.sampledAt ?? null,
    processes: processMetrics.payload,
    nodeProcessesTotal: processMetrics.nodeSummary?.total ?? null,
    nodeProcessesListed: processMetrics.nodeSummary?.listed ?? null,
    nodeProcessesSampledAt: processMetrics.nodeSummary?.sampledAt ?? null,
    nodeProcesses: processMetrics.nodePayload,
    https: isHttpsReachable,
    certExpiration: certExpiration
  };
}

async function emitMetrics(socket) {
  try {
    if (!stackInfo) {
      stackInfo = await collectStackInfo();
    }
    const metrics = await collectMetrics();
    latestMetrics = {
      hostKey: HOST_KEY,
      hostname: os.hostname(),
      domain,
      instanceType: INSTANCE_TYPE,
      ip: clientIP,
      stack: stackInfo,
      metrics,
      updatedAt: Date.now()
    };

    if (!metricsEmitLogged) {
      metricsEmitLogged = true;
      console.log(
        `[CLIENT] Sending metrics to master: hostKey=${HOST_KEY} socketId=${socket.id || 'unknown'} intervalMs=${METRICS_INTERVAL_MS}`,
      );
    }

    socket.emit('avero:msg', {
      type: 'host.metrics',
      token: HOST_REG_TOKEN,
      hostKey: HOST_KEY,
      metrics,
      stack: stackInfo,
      ip: clientIP,
    });
  } catch (err) {
    console.error('[CLIENT] Failed to gather metrics:', err.message);
  }
}

// Init once
async function init() {
  if (!masterUrl) {
    console.error('[CLIENT] MASTER_URL is required');
    process.exit(1);
  }
  if (!HOST_REG_TOKEN) {
    console.error('[CLIENT] HOST_REG_TOKEN is required');
    process.exit(1);
  }
  await fetchClientIP();
    if (ENABLE_CERT_CHECK) {
        try {
            await checkMasterCertificate();
            } catch {
            console.warn('[WARN] Proceeding without verified cert');
        }
    }
  console.log(
    `[CLIENT] Connecting to master: url=${safeUrl(masterUrl)} hostKey=${HOST_KEY} hostname=${os.hostname()} domain=${domain} instanceType=${INSTANCE_TYPE}`,
  );
  const socket = io(masterUrl, {
    transports: ['websocket'],
    reconnection: true
  });

  socket.on('connect', () => {
    const transport = socket.io.engine?.transport?.name || 'unknown';
    console.log(
      `[CLIENT] Connected to master: socketId=${socket.id} transport=${transport} hostKey=${HOST_KEY} domain=${domain}`,
    );
    const hostname = os.hostname();
    const registerHost = async () => {
      if (!stackInfo) {
        stackInfo = await collectStackInfo();
      }
      const metrics = await collectMetrics();
      console.log(
        `[CLIENT] Registering host with master: hostKey=${HOST_KEY} hostname=${hostname} ip=${clientIP} stackOs=${stackInfo.os}`,
      );
      socket.emit('avero:msg', {
        type: 'host.register',
        token: HOST_REG_TOKEN,
        host: {
          hostKey: HOST_KEY,
          hostname,
          instanceType: INSTANCE_TYPE,
          domain,
          ip: clientIP,
          stack: stackInfo,
          metrics,
        },
      });
    };

    registerHost().catch((err) => {
      console.error('[CLIENT] Failed to register host:', err.message);
    });

    const interval = setInterval(() => emitMetrics(socket), METRICS_INTERVAL_MS);
    socket.once('disconnect', () => {
      clearInterval(interval);
      metricsEmitLogged = false;
    });
  });

  socket.on('disconnect', (reason) => {
    console.warn(`[CLIENT] Disconnected from master: reason=${reason} socketId=${socket.id || 'unknown'}`);
  });

  socket.on('connect_error', (err) => {
    console.error(`[CLIENT] Connection error: url=${safeUrl(masterUrl)} message=${err.message}`);
  });

  socket.io.on('reconnect_attempt', (attempt) => {
    console.log(`[CLIENT] Reconnect attempt ${attempt} to master ${safeUrl(masterUrl)}`);
  });

  socket.io.on('reconnect', (attempt) => {
    console.log(`[CLIENT] Reconnected to master after ${attempt} attempt(s): socketId=${socket.id}`);
  });

  socket.io.on('reconnect_error', (err) => {
    console.error(`[CLIENT] Reconnect error: ${err.message}`);
  });

  socket.io.on('reconnect_failed', () => {
    console.error(`[CLIENT] Reconnect failed: url=${safeUrl(masterUrl)}`);
  });

  socket.on('avero:msg', (payload) => {
    if (!payload || typeof payload !== 'object') {
      return;
    }
    if (payload.type === 'host.registered') {
      console.log(
        `[CLIENT] Host registered by master: hostId=${payload.hostId} status=${payload.status} hostKey=${HOST_KEY}`,
      );
    }
    if (payload.type === 'error') {
      console.error(`[CLIENT] Server error: ${payload.code || 'unknown'} ${payload.message || ''}`);
    }
  });

  // Health endpoint
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      domain,
      updatedAt: latestMetrics.updatedAt || null,
      metrics: latestMetrics.metrics || {}
    }));
  }).listen(HEALTH_PORT, () => {
    console.log(`[CLIENT] Health check server listening on port ${HEALTH_PORT}`);
  });
}

init();
