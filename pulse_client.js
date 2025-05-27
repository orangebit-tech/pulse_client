const http = require('http');
const { io } = require('socket.io-client');
const si = require('systeminformation');
const os = require('os');
const axios = require('axios');
console.log("[CLIENT] Pulse client starting...");

// Update here
const INSTANCE_TYPE = "web-server" // e.g. "web-server", "api-server", "database-compute-server" etc.
const domain = 'pulse.orangebit.dev'; // Your Domain here
const HEALTH_PORT = 9443;
const ENABLE_CERT_CHECK = true;
// --

const masterUrl = 'https://pulse.orangebit.dev:3000'; // do not change
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
// Collect metrics
async function sendMetrics(socket) {
  try {
    const uptime = os.uptime();
    const netStats = await si.networkStats();
    const tx = netStats[0]?.tx_bytes || 0;
    const rx = netStats[0]?.rx_bytes || 0;
    const mem = await si.mem();
    const cpu = await si.currentLoad();
    const disks = await si.fsSize();
    const ioStats = await si.disksIO();
    const disk = disks[0] || {};

    latestMetrics = {
      domain,
      role: "api",
      instanceType: INSTANCE_TYPE,
      id: "",
      ip: clientIP,
      metrics: {
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
        https: isHttpsReachable,
        certExpiration: certExpiration
      },
      updatedAt: Date.now()
    };

    socket.emit('server_metrics', latestMetrics);
  } catch (err) {
    console.error('[CLIENT] Failed to gather metrics:', err.message);
  }
}

// Init once
async function init() {
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
    setInterval(() => sendMetrics(socket), 1000);
  });

  socket.on('connect_error', (err) => {
    console.error(`[CLIENT] Connection error: ${err.message}`);
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
