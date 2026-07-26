const http = require('http');
const fs = require('fs');
const { execFile } = require('child_process');
const { io } = require('socket.io-client');
const si = require('systeminformation');
const os = require('os');
const axios = require('axios');
console.log("[CLIENT] Pulse client starting...");
require('dotenv').config();
const AGENT_VERSION = require('./package.json').version;

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
const RESOURCE_REPORTING_ENABLED = process.env.RESOURCE_REPORTING_ENABLED === 'true';
const RESOURCE_REPORT_INTERVAL_MS = readNonNegativeInt('RESOURCE_REPORT_INTERVAL_MS', 30000);
const RESOURCE_DEFINITIONS_JSON = process.env.RESOURCE_DEFINITIONS_JSON || null;
const RESOURCE_DEFINITIONS_PATH = process.env.RESOURCE_DEFINITIONS_PATH || null;
const PROVIDER_MODE = process.env.PROVIDER_MODE === 'true';
const COMMAND_AUTH_TOKEN = process.env.COMMAND_AUTH_TOKEN || null;
const PROVIDER_REQUEST_CACHE_LIMIT = 500;
// Storage telemetry is optional at load time on purpose: a partial deploy that
// misses src/ must degrade to the previous metrics set, never crash-loop the
// agent and take the host's monitoring offline with it.
let storageCollector = { collect: async () => null };
try {
  const createStorageCollector = require('./src/storage');
  storageCollector = createStorageCollector({
    env: process.env,
    log: console.log,
    warn: console.warn,
  });
} catch (err) {
  console.warn(
    `[CLIENT] Storage collector unavailable (${err.message}) — continuing without storage telemetry. ` +
      'Check that src/storage.js was deployed.',
  );
}
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
let privateIp = null;
let certExpiration = null;
let isHttpsReachable = false;
let metricsEmitLogged = false;
let proxmoxProvider = null;
const providerRequestCache = new Map();

const PROVIDER_CAPABILITIES = {
  canProvision: true,
  provider: 'proxmox',
  shapes: ['vm', 'lxc'],
};

const PROVIDER_COMMAND_RESULT_TYPES = {
  'instance.provision': 'instance.provision.result',
  'instance.destroy': 'instance.destroy.result',
  'instance.status': 'instance.status.result',
};

function providerLog(message, ...args) {
  console.log(`[PROVIDER] ${message}`, ...args);
}

function providerWarn(message, ...args) {
  console.warn(`[PROVIDER] ${message}`, ...args);
}

function getProvider() {
  if (!PROVIDER_MODE) {
    return null;
  }
  if (!proxmoxProvider) {
    // Lazy-loaded so normal guest agents do not load provider integration code.
    const createProxmoxProvider = require('./src/providers/proxmox');
    proxmoxProvider = createProxmoxProvider({
      env: process.env,
      log: providerLog,
      warn: providerWarn,
    });
  }
  return proxmoxProvider;
}

function getResultType(commandType) {
  return PROVIDER_COMMAND_RESULT_TYPES[commandType] || null;
}

function isProviderCommand(payload) {
  return Boolean(payload && getResultType(payload.type));
}

function isCommandAuthorized(payload) {
  return Boolean(COMMAND_AUTH_TOKEN && payload.commandAuthToken === COMMAND_AUTH_TOKEN);
}

function emitProviderResult(socket, result) {
  socket.emit('avero:msg', {
    ...result,
    token: HOST_REG_TOKEN,
    hostKey: HOST_KEY,
  });
}

function emitProviderProgress(socket, requestId, phase) {
  socket.emit('avero:msg', {
    type: 'instance.provision.progress',
    token: HOST_REG_TOKEN,
    hostKey: HOST_KEY,
    requestId,
    phase,
  });
}

function trimProviderRequestCache() {
  if (providerRequestCache.size <= PROVIDER_REQUEST_CACHE_LIMIT) {
    return;
  }

  for (const [requestId, entry] of providerRequestCache.entries()) {
    if (providerRequestCache.size <= PROVIDER_REQUEST_CACHE_LIMIT) {
      return;
    }
    if (entry.status !== 'pending') {
      providerRequestCache.delete(requestId);
    }
  }
}

function makeProviderResult(commandType, requestId, fields) {
  return {
    type: getResultType(commandType),
    requestId,
    ...fields,
  };
}

function validateProviderCommandPayload(payload) {
  if (payload.type === 'instance.provision') {
    if (payload.shape !== 'vm' && payload.shape !== 'lxc') {
      throw new Error('invalid shape: expected "vm" or "lxc"');
    }
    if (!payload.spec || typeof payload.spec !== 'object') {
      throw new Error('missing spec');
    }
    return;
  }

  if (payload.type === 'instance.destroy' || payload.type === 'instance.status') {
    if (typeof payload.instanceId !== 'string' || payload.instanceId.trim() === '') {
      throw new Error('missing instanceId');
    }
  }
}

async function executeProviderCommand(socket, payload) {
  const provider = getProvider();
  if (!provider) {
    return makeProviderResult(payload.type, payload.requestId, {
      ok: false,
      error: 'provider mode is disabled',
    });
  }

  try {
    validateProviderCommandPayload(payload);

    if (payload.type === 'instance.provision') {
      emitProviderProgress(socket, payload.requestId, 'accepted');
      const created = await provider.createInstance({
        shape: payload.shape,
        spec: payload.spec,
        requestId: payload.requestId,
        onProgress: (phase) => emitProviderProgress(socket, payload.requestId, phase),
      });
      return makeProviderResult(payload.type, payload.requestId, {
        ok: true,
        instanceId: created.instanceId,
        ip: created.ip || null,
        state: created.state || 'running',
      });
    }

    if (payload.type === 'instance.destroy') {
      const destroyed = await provider.destroyInstance(payload.instanceId);
      if (destroyed && destroyed.ok === false) {
        return makeProviderResult(payload.type, payload.requestId, {
          ok: false,
          found: destroyed.found === true,
          error: destroyed.error || 'destroy failed',
        });
      }
      return makeProviderResult(payload.type, payload.requestId, {
        ok: true,
        found: destroyed?.found === true,
      });
    }

    if (payload.type === 'instance.status') {
      const status = await provider.getInstanceStatus(payload.instanceId);
      return makeProviderResult(payload.type, payload.requestId, {
        ok: true,
        state: status.state,
        stats: status.stats || null,
      });
    }
  } catch (err) {
    return makeProviderResult(payload.type, payload.requestId, {
      ok: false,
      error: err.message,
    });
  }

  return makeProviderResult(payload.type, payload.requestId, {
    ok: false,
    error: `unsupported command type: ${payload.type}`,
  });
}

async function handleProviderCommand(socket, payload) {
  if (payload.hostKey !== HOST_KEY) {
    providerWarn(
      `Ignoring ${payload.type} for hostKey=${payload.hostKey || '<missing>'}; this hostKey=${HOST_KEY}`,
    );
    return;
  }

  const requestId = typeof payload.requestId === 'string' ? payload.requestId.trim() : '';
  const resultType = getResultType(payload.type);
  if (!requestId) {
    emitProviderResult(socket, {
      type: resultType,
      requestId: payload.requestId || null,
      ok: false,
      error: 'missing requestId',
    });
    return;
  }
  payload.requestId = requestId;

  if (!isCommandAuthorized(payload)) {
    emitProviderResult(socket, makeProviderResult(payload.type, requestId, {
      ok: false,
      error: COMMAND_AUTH_TOKEN
        ? 'unauthorized: invalid commandAuthToken'
        : 'unauthorized: COMMAND_AUTH_TOKEN is not configured',
    }));
    return;
  }

  const cached = providerRequestCache.get(requestId);
  if (cached) {
    providerLog(`Re-emitting cached result for requestId=${requestId} type=${cached.type}`);
    if (cached.result) {
      emitProviderResult(socket, cached.result);
      return;
    }
    cached.promise.then((result) => emitProviderResult(socket, result));
    return;
  }

  providerLog(`Handling ${payload.type} requestId=${requestId}`);
  const entry = {
    type: payload.type,
    status: 'pending',
    result: null,
    promise: null,
  };
  providerRequestCache.set(requestId, entry);
  trimProviderRequestCache();

  entry.promise = executeProviderCommand(socket, payload)
    .then((result) => {
      entry.status = 'completed';
      entry.result = result;
      emitProviderResult(socket, result);
      return result;
    })
    .catch((err) => {
      const result = makeProviderResult(payload.type, requestId, {
        ok: false,
        error: err.message,
      });
      entry.status = 'completed';
      entry.result = result;
      emitProviderResult(socket, result);
      return result;
    });

  await entry.promise;
}

// Fetch public IP once
async function fetchClientIP() {
  try {
    const response = await axios.get('https://api64.ipify.org?format=json');
    clientIP = response.data.ip;
    console.log("Got client IP:", clientIP);
  } catch (err) {
    console.error("Failed to fetch IP:", err.message);
  }
}

// Fetch the host's real VPC/LAN private IP.
// On EC2, the metadata service returns the actual instance private IP even
// when called from inside a Docker container (link-local, routed by hypervisor).
// Falls back to os.networkInterfaces() for non-AWS environments.
async function fetchPrivateIp() {
  // Try IMDSv2 first (required on most modern EC2 instances)
  try {
    const tokenResp = await axios.put(
      'http://169.254.169.254/latest/api/token',
      null,
      { headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' }, timeout: 2000 }
    );
    const ipResp = await axios.get('http://169.254.169.254/latest/meta-data/local-ipv4', {
      headers: { 'X-aws-ec2-metadata-token': tokenResp.data },
      timeout: 2000,
    });
    const ip = (ipResp.data || '').toString().trim();
    if (ip) {
      privateIp = ip;
      console.log("Got private IP (EC2 IMDSv2):", privateIp);
      return;
    }
  } catch (_) {
    // IMDSv2 unavailable — try IMDSv1
  }

  // IMDSv1 fallback
  try {
    const response = await axios.get('http://169.254.169.254/latest/meta-data/local-ipv4', {
      timeout: 2000,
    });
    const ip = (response.data || '').toString().trim();
    if (ip) {
      privateIp = ip;
      console.log("Got private IP (EC2 IMDSv1):", privateIp);
      return;
    }
  } catch (_) {
    // Not on EC2 or metadata service unreachable — fall through
  }

  // Fallback: scan host network interfaces
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    if (/^(lo|docker|br-|veth)/i.test(name)) continue;
    for (const iface of ifaces[name] || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const { address } = iface;
      if (
        address.startsWith('10.') ||
        address.startsWith('192.168.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(address)
      ) {
        privateIp = address;
        console.log("Got private IP (network interfaces):", privateIp);
        return;
      }
    }
  }
  console.warn("Could not determine private IP");
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
  const storage = await storageCollector.collect();

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
    ...(storage ? { storage } : {}),
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
      privateIp: privateIp,
      agentVersion: AGENT_VERSION,
    });
  } catch (err) {
    console.error('[CLIENT] Failed to gather metrics:', err.message);
  }
}

// === Resource Reporting ===

function expandPlaceholders(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\$\{HOST_KEY\}/g, HOST_KEY)
    .replace(/\$\{DOMAIN\}/g, domain)
    .replace(/\$\{INSTANCE_TYPE\}/g, INSTANCE_TYPE);
}

function expandResourcePlaceholders(obj) {
  if (typeof obj === 'string') return expandPlaceholders(obj);
  if (Array.isArray(obj)) return obj.map(expandResourcePlaceholders);
  if (obj !== null && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = expandResourcePlaceholders(value);
    }
    return result;
  }
  return obj;
}

function loadResourceDefinitions() {
  if (RESOURCE_DEFINITIONS_PATH) {
    try {
      const content = fs.readFileSync(RESOURCE_DEFINITIONS_PATH, 'utf8');
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) {
        console.warn('[RESOURCES] RESOURCE_DEFINITIONS_PATH must contain a JSON array');
        return [];
      }
      return parsed;
    } catch (err) {
      console.warn('[RESOURCES] Failed to load resource definitions from path:', err.message);
      return [];
    }
  }

  if (RESOURCE_DEFINITIONS_JSON) {
    try {
      const parsed = JSON.parse(RESOURCE_DEFINITIONS_JSON);
      if (!Array.isArray(parsed)) {
        console.warn('[RESOURCES] RESOURCE_DEFINITIONS_JSON must be a JSON array');
        return [];
      }
      return parsed;
    } catch (err) {
      console.warn('[RESOURCES] Failed to parse RESOURCE_DEFINITIONS_JSON:', err.message);
      return [];
    }
  }

  return [];
}

async function buildProviderResourceDefinition() {
  const provider = getProvider();
  if (!provider) {
    return null;
  }

  const capacity = await provider.getCapacity();
  return {
    resourceKey: '${HOST_KEY}:provider:proxmox',
    externalId: '${HOST_KEY}',
    type: 'HOST',
    provider: 'PROXMOX',
    name: `${os.hostname()} Proxmox Provider`,
    status: 'ACTIVE',
    desiredStatus: 'ACTIVE',
    stateJson: {
      hostKey: '${HOST_KEY}',
      provider: 'proxmox',
      node: capacity.node || null,
      sampledAt: capacity.sampledAt || Date.now(),
    },
    metadataJson: {
      agentVersion: AGENT_VERSION,
      providerMode: true,
    },
    capabilitiesJson: {
      ...PROVIDER_CAPABILITIES,
      totalVcpu: capacity.totalVcpu,
      freeVcpu: capacity.freeVcpu,
      totalMemoryMb: capacity.totalMemoryMb,
      freeMemoryMb: capacity.freeMemoryMb,
      storagePools: capacity.storagePools,
    },
  };
}

async function collectResourceDefinitions() {
  const definitions = loadResourceDefinitions();

  if (PROVIDER_MODE) {
    try {
      const providerResource = await buildProviderResourceDefinition();
      if (providerResource) {
        definitions.push(providerResource);
      }
    } catch (err) {
      providerWarn('Failed to collect provider capacity:', err.message);
    }
  }

  return definitions;
}

async function enrichResourceState(resource) {
  let state = {};
  const raw = resource.stateJson;
  if (typeof raw === 'string') {
    try { state = JSON.parse(raw); } catch { state = {}; }
  } else if (raw !== null && typeof raw === 'object') {
    state = { ...raw };
  }

  if (state.containerName) {
    try {
      const containers = await si.dockerContainers();
      const name = state.containerName;
      const match = containers.find((c) => c.name === name || c.name === `/${name}`);
      if (match) {
        state.containerId = match.id;
        state.containerState = match.state;
        state.containerStatus = match.status;
        state.containerImage = match.image;
      }
    } catch (err) {
      console.warn(`[RESOURCES] Docker enrichment failed for ${resource.resourceKey || '<unknown>'}:`, err.message);
    }
  }

  return state;
}

function normalizeJsonField(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

async function reportResources() {
  const definitions = await collectResourceDefinitions();
  if (definitions.length === 0) return;

  for (const rawDef of definitions) {
    const def = expandResourcePlaceholders(rawDef);
    const resourceKey = def.resourceKey || '<unknown>';

    try {
      const stateJson = await enrichResourceState(def);

      await axios.post(`${masterUrl}/infra/resources/register`, {
        token: HOST_REG_TOKEN,
        hostKey: HOST_KEY,
        resource: {
          resourceKey: def.resourceKey,
          externalId: def.externalId,
          type: def.type,
          provider: def.provider,
          name: def.name,
          status: def.status,
          desiredStatus: def.desiredStatus,
          configJson: normalizeJsonField(def.configJson),
          stateJson: normalizeJsonField(stateJson),
          metadataJson: normalizeJsonField(def.metadataJson),
          capabilitiesJson: normalizeJsonField(def.capabilitiesJson),
        },
      });
      console.log(`[RESOURCES] Registered resource: ${resourceKey}`);
    } catch (err) {
      console.warn(`[RESOURCES] Failed to register resource ${resourceKey}:`, err.message);
    }
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
  if (PROVIDER_MODE) {
    providerLog('Provider mode enabled: provider=proxmox shapes=vm,lxc');
    if (!COMMAND_AUTH_TOKEN) {
      providerWarn('COMMAND_AUTH_TOKEN is not configured; inbound provider commands will be rejected');
    }
    try {
      getProvider();
    } catch (err) {
      providerWarn('Failed to initialize provider integration:', err.message);
    }
  }
  await Promise.all([fetchClientIP(), fetchPrivateIp()]);
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
      const hostPayload = {
        hostKey: HOST_KEY,
        hostname,
        instanceType: INSTANCE_TYPE,
        domain,
        ip: clientIP,
        privateIp: privateIp,
        agentVersion: AGENT_VERSION,
        stack: stackInfo,
        metrics,
      };
      if (PROVIDER_MODE) {
        hostPayload.capabilities = PROVIDER_CAPABILITIES;
      }
      socket.emit('avero:msg', {
        type: 'host.register',
        token: HOST_REG_TOKEN,
        host: hostPayload,
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
    if (PROVIDER_MODE && isProviderCommand(payload)) {
      handleProviderCommand(socket, payload).catch((err) => {
        providerWarn(`Failed to handle ${payload.type}:`, err.message);
      });
    }
  });

  if (RESOURCE_REPORTING_ENABLED || PROVIDER_MODE) {
    console.log(`[RESOURCES] Resource reporting enabled: interval=${RESOURCE_REPORT_INTERVAL_MS}ms`);
    reportResources();
    setInterval(reportResources, RESOURCE_REPORT_INTERVAL_MS);
  }

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
