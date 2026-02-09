const http = require('http');
const { io } = require('socket.io-client');
const si = require('systeminformation');
const os = require('os');
const axios = require('axios');
console.log("[CLIENT] Pulse client starting...");
require('dotenv').config();

// Update here

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
let dockerContainersLogged = false;
let lastDockerContainers = null;
let lastDockerContainersHash = null;
let lastDockerContainersAt = 0;


let latestMetrics = {};
let clientIP = '0.0.0.0';
let certExpiration = null;
let isHttpsReachable = false;

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
  const socket = io(masterUrl, {
    transports: ['websocket'],
    reconnection: true
  });

  socket.on('connect', () => {
    console.log(`[CLIENT] Connected to master as ${domain}`);
    const hostname = os.hostname();
    const registerHost = async () => {
      if (!stackInfo) {
        stackInfo = await collectStackInfo();
      }
      const metrics = await collectMetrics();
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
    socket.once('disconnect', () => clearInterval(interval));
  });

  socket.on('connect_error', (err) => {
    console.error(`[CLIENT] Connection error: ${err.message}`);
  });

  socket.on('avero:msg', (payload) => {
    if (!payload || typeof payload !== 'object') {
      return;
    }
    if (payload.type === 'host.registered') {
      console.log(`[CLIENT] Host registered: ${payload.hostId} status=${payload.status}`);
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
