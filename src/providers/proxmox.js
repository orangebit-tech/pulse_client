const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const axios = require('axios');

const MANAGED_MARKER = 'avero-managed';

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toPositiveInt(value, fallback = undefined) {
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function bytesToMb(value) {
  return Math.round(toNumber(value) / 1024 / 1024);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pathPart(value) {
  return encodeURIComponent(String(value));
}

function createFormData(data) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data || {})) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    params.set(key, String(value));
  }
  return params;
}

function sanitizeTag(value) {
  const tag = String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return tag || 'unknown';
}

function buildMarker(requestId) {
  const safeRequestId = sanitizeTag(requestId);
  return {
    description: `${MANAGED_MARKER}\nrequestId=${requestId || 'unknown'}`,
    tags: `${MANAGED_MARKER};avero-request-${safeRequestId}`,
  };
}

function descriptionHasRequestId(config, requestId) {
  const description = String(config?.description || '');
  return description.includes(`requestId=${requestId}`) || description.includes(String(requestId));
}

function hasManagedMarker(config) {
  const description = String(config?.description || '');
  const rawTags = String(config?.tags || '');
  const tags = rawTags
    .split(/[;,]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
  return description.includes(MANAGED_MARKER) || tags.includes(MANAGED_MARKER);
}

function normalizeShape(shape) {
  if (shape === 'vm' || shape === 'qemu') return 'vm';
  if (shape === 'lxc' || shape === 'ct') return 'lxc';
  throw new Error('invalid shape: expected "vm" or "lxc"');
}

function resourceTypeToShape(type) {
  return type === 'qemu' ? 'vm' : 'lxc';
}

function endpointForType(type) {
  return type === 'qemu' ? 'qemu' : 'lxc';
}

function instanceIdFor(type, vmid) {
  return `${resourceTypeToShape(type)}:${vmid}`;
}

function parseInstanceId(instanceId) {
  const raw = String(instanceId || '').trim();
  const typed = raw.match(/^(vm|qemu|lxc|ct):(\d+)$/i);
  if (typed) {
    const type = typed[1].toLowerCase();
    return {
      vmid: typed[2],
      type: type === 'vm' ? 'qemu' : type === 'ct' ? 'lxc' : type,
    };
  }

  if (/^\d+$/.test(raw)) {
    return {
      vmid: raw,
      type: null,
    };
  }

  throw new Error('invalid instanceId');
}

function normalizeVmNetworkConfig(networkConfig) {
  if (!networkConfig) return {};
  if (typeof networkConfig === 'string') {
    return { ipconfig0: networkConfig };
  }
  if (typeof networkConfig !== 'object') {
    return {};
  }

  const result = {};
  if (networkConfig.net0) {
    result.net0 = networkConfig.net0;
  }
  if (networkConfig.ipconfig0) {
    result.ipconfig0 = networkConfig.ipconfig0;
  } else if (networkConfig.ip) {
    const ip = networkConfig.cidr && !String(networkConfig.ip).includes('/')
      ? `${networkConfig.ip}/${networkConfig.cidr}`
      : networkConfig.ip;
    result.ipconfig0 = `ip=${ip}${networkConfig.gateway ? `,gw=${networkConfig.gateway}` : ''}`;
  }
  return result;
}

function normalizeLxcNetworkConfig(networkConfig) {
  if (!networkConfig) return {};
  if (typeof networkConfig === 'string') {
    return { net0: networkConfig };
  }
  if (typeof networkConfig !== 'object') {
    return {};
  }

  if (networkConfig.net0) {
    return { net0: networkConfig.net0 };
  }

  const name = networkConfig.name || 'eth0';
  const bridge = networkConfig.bridge || 'vmbr0';
  const ip = networkConfig.ip && networkConfig.cidr && !String(networkConfig.ip).includes('/')
    ? `${networkConfig.ip}/${networkConfig.cidr}`
    : networkConfig.ip || 'dhcp';
  const gateway = networkConfig.gateway ? `,gw=${networkConfig.gateway}` : '';
  return { net0: `name=${name},bridge=${bridge},ip=${ip}${gateway}` };
}

function sshKeysValue(sshKeys) {
  return Array.isArray(sshKeys) && sshKeys.length > 0 ? sshKeys.join('\n') : undefined;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\"'\"'")}'`;
}

function indentLines(value, spaces) {
  const prefix = ' '.repeat(spaces);
  return String(value)
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function mergeCiCustom(existing, userSnippetRef) {
  if (!userSnippetRef) return existing;

  const entries = {};
  String(existing || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const index = part.indexOf('=');
      if (index === -1) return;
      entries[part.slice(0, index)] = part.slice(index + 1);
    });
  entries.user = userSnippetRef;

  return Object.entries(entries)
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
}

function normalizeAgentSpec(spec) {
  const agent = spec?.agent;
  if (!agent || agent.enabled !== true) {
    return null;
  }

  const normalized = {
    hostKey: trim(agent.hostKey),
    regToken: trim(agent.regToken),
    masterUrl: trim(agent.masterUrl),
    instanceType: trim(agent.instanceType),
    installCommand: trim(agent.installCommand),
    serviceName: trim(agent.serviceName) || 'pulse-client',
    snippetStorage: trim(agent.snippetStorage) || 'local',
    snippetDir: trim(agent.snippetDir) || '/var/lib/vz/snippets',
  };

  const missing = ['hostKey', 'regToken', 'masterUrl', 'instanceType']
    .filter((key) => !normalized[key]);
  if (missing.length > 0) {
    throw new Error(`agent.enabled requires agent.${missing.join(', agent.')}`);
  }

  return normalized;
}

function buildAgentEnv(agent) {
  return [
    `HOST_KEY=${shellQuote(agent.hostKey)}`,
    `HOST_REG_TOKEN=${shellQuote(agent.regToken)}`,
    `MASTER_URL=${shellQuote(agent.masterUrl)}`,
    `INSTANCE_TYPE=${shellQuote(agent.instanceType)}`,
    'PROVIDER_MODE=false',
  ].join('\n');
}

function buildAgentBootstrapScript(agent) {
  const serviceName = agent.serviceName;
  const installCommand = agent.installCommand
    ? `\n${agent.installCommand}\n`
    : '';

  return `#!/bin/sh
set -eu
if [ -f /etc/avero-pulse-agent.env ]; then
  set -a
  . /etc/avero-pulse-agent.env
  set +a
fi${installCommand}
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload 2>/dev/null || true
  systemctl enable ${shellQuote(serviceName)} 2>/dev/null || true
  systemctl restart ${shellQuote(serviceName)} 2>/dev/null || true
fi
if command -v service >/dev/null 2>&1; then
  service ${shellQuote(serviceName)} restart 2>/dev/null || true
fi
`;
}

function buildAgentCloudInit(agent) {
  const envContent = buildAgentEnv(agent);
  const bootstrapScript = buildAgentBootstrapScript(agent);

  return `#cloud-config
write_files:
  - path: /etc/avero-pulse-agent.env
    owner: root:root
    permissions: '0600'
    content: |
${indentLines(envContent, 6)}
  - path: /usr/local/sbin/avero-pulse-agent-bootstrap.sh
    owner: root:root
    permissions: '0755'
    content: |
${indentLines(bootstrapScript, 6)}
runcmd:
  - [ /bin/sh, /usr/local/sbin/avero-pulse-agent-bootstrap.sh ]
`;
}

function buildCapacity(node, status, storageRows) {
  const cpuCount = toNumber(status?.cpuinfo?.cpus || status?.cpuinfo?.cores || os.cpus().length, 0);
  const cpuUsedRatio = Math.max(0, Math.min(1, toNumber(status?.cpu, 0)));
  const memory = status?.memory || {};

  const storagePools = {};
  for (const row of Array.isArray(storageRows) ? storageRows : []) {
    const name = row.storage || row.name;
    if (!name) continue;
    storagePools[name] = {
      totalBytes: toNumber(row.total, 0),
      freeBytes: toNumber(row.avail ?? row.free, 0),
      usedBytes: toNumber(row.used, 0),
      active: row.active ?? null,
      enabled: row.enabled ?? null,
      content: row.content || null,
    };
  }

  return {
    node,
    sampledAt: Date.now(),
    totalVcpu: cpuCount,
    freeVcpu: Math.max(0, Number((cpuCount * (1 - cpuUsedRatio)).toFixed(2))),
    totalMemoryMb: bytesToMb(memory.total),
    freeMemoryMb: bytesToMb(memory.free),
    storagePools,
  };
}

function statusStats(status) {
  return {
    cpu: status.cpu ?? null,
    memoryBytes: status.mem ?? status.memory?.used ?? null,
    maxMemoryBytes: status.maxmem ?? status.memory?.total ?? null,
    diskBytes: status.disk ?? null,
    maxDiskBytes: status.maxdisk ?? null,
    uptime: status.uptime ?? null,
    netInBytes: status.netin ?? null,
    netOutBytes: status.netout ?? null,
    diskReadBytes: status.diskread ?? null,
    diskWriteBytes: status.diskwrite ?? null,
  };
}

function extractIpFromAgentInterfaces(data) {
  const interfaces = data?.result || data;
  if (!Array.isArray(interfaces)) return null;
  for (const iface of interfaces) {
    for (const addr of iface['ip-addresses'] || []) {
      const ip = addr['ip-address'];
      if (addr['ip-address-type'] === 'ipv4' && ip && !ip.startsWith('127.')) {
        return ip;
      }
    }
  }
  return null;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
      if (error) {
        const detail = trim(stderr) || error.message;
        reject(new Error(`${command} ${args.join(' ')} failed: ${detail}`));
        return;
      }
      resolve(stdout.toString());
    });
  });
}

async function runJson(command, args) {
  const stdout = await run(command, args);
  const trimmed = trim(stdout);
  return trimmed ? JSON.parse(trimmed) : null;
}

function parseCliConfig(text) {
  const config = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    config[key] = value;
  }
  return config;
}

module.exports = function createProxmoxProvider(options = {}) {
  const env = options.env || process.env;
  const log = options.log || (() => {});
  const warn = options.warn || (() => {});

  const apiUrl = trim(env.PROXMOX_API_URL).replace(/\/+$/, '');
  const apiTokenId = trim(env.PROXMOX_API_TOKEN_ID);
  const apiTokenSecret = trim(env.PROXMOX_API_TOKEN_SECRET);
  const configuredNode = trim(env.PROXMOX_NODE);
  const node = configuredNode || os.hostname();
  const defaultStorage = trim(env.PROVISION_DEFAULT_STORAGE);
  const defaultVmTemplate = trim(env.PROVISION_VM_TEMPLATE);
  const defaultLxcTemplate = trim(env.PROVISION_LXC_TEMPLATE);
  const hasCompleteApiConfig = Boolean(apiUrl && apiTokenId && apiTokenSecret && configuredNode);
  const hasPartialApiConfig = Boolean(apiUrl || apiTokenId || apiTokenSecret || configuredNode);

  if (!hasCompleteApiConfig && hasPartialApiConfig) {
    warn('Incomplete Proxmox API config; falling back to local qm/pct/pvesh commands');
  }
  if (!configuredNode) {
    warn(`PROXMOX_NODE is not set; using local hostname "${node}" for CLI fallback`);
  }

  const api = hasCompleteApiConfig
    ? axios.create({
        baseURL: `${apiUrl}/api2/json`,
        timeout: 60000,
        headers: {
          Authorization: `PVEAPIToken=${apiTokenId}=${apiTokenSecret}`,
        },
      })
    : null;

  if (api) {
    log(`Using Proxmox REST API: url=${apiUrl} node=${node}`);
  } else {
    log('Using local Proxmox CLI fallback: qm/pct/pvesh');
  }

  async function apiRequest(method, endpoint, data) {
    const request = {
      method,
      url: endpoint,
    };
    if (method.toLowerCase() === 'get') {
      request.params = data || undefined;
    } else if (data) {
      request.data = createFormData(data);
      request.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    }
    const response = await api.request(request);
    return response.data?.data;
  }

  async function waitForApiTask(upid, timeoutMs = 10 * 60 * 1000, taskNode = node) {
    if (!upid || typeof upid !== 'string' || !upid.startsWith('UPID:')) {
      return;
    }

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const status = await apiRequest(
        'get',
        `/nodes/${pathPart(taskNode)}/tasks/${pathPart(upid)}/status`,
      );
      if (status?.status === 'stopped') {
        if (status.exitstatus && status.exitstatus !== 'OK') {
          throw new Error(`Proxmox task failed: ${status.exitstatus}`);
        }
        return;
      }
      await delay(1000);
    }
    throw new Error('Proxmox task timed out');
  }

  async function apiNextId() {
    const nextId = await apiRequest('get', '/cluster/nextid');
    return String(nextId);
  }

  async function cliNextId() {
    const nextId = await runJson('pvesh', ['get', '/cluster/nextid', '--output-format', 'json']);
    return String(nextId);
  }

  async function nextId() {
    return api ? apiNextId() : cliNextId();
  }

  function templateFor(shape, spec) {
    const template = trim(spec?.template) || (shape === 'vm' ? defaultVmTemplate : defaultLxcTemplate);
    if (!template) {
      throw new Error(
        shape === 'vm'
          ? 'missing VM template: set spec.template or PROVISION_VM_TEMPLATE'
          : 'missing LXC template: set spec.template or PROVISION_LXC_TEMPLATE',
      );
    }
    return template;
  }

  async function writeAgentCloudInitSnippet(agent, requestId) {
    const fileName = `avero-agent-${sanitizeTag(requestId)}.yaml`;
    const filePath = path.join(agent.snippetDir, fileName);

    await fs.mkdir(agent.snippetDir, { recursive: true });
    await fs.writeFile(filePath, buildAgentCloudInit(agent), { mode: 0o600 });

    return `${agent.snippetStorage}:snippets/${fileName}`;
  }

  async function injectLxcAgent(vmid, agent, requestId) {
    const suffix = sanitizeTag(requestId);
    const tmpDir = os.tmpdir();
    const envPath = path.join(tmpDir, `avero-pulse-agent-${suffix}.env`);
    const scriptPath = path.join(tmpDir, `avero-pulse-agent-bootstrap-${suffix}.sh`);

    await fs.writeFile(envPath, buildAgentEnv(agent), { mode: 0o600 });
    await fs.writeFile(scriptPath, buildAgentBootstrapScript(agent), { mode: 0o700 });

    try {
      await run('pct', ['exec', String(vmid), '--', '/bin/sh', '-lc', 'mkdir -p /usr/local/sbin']);
      await run('pct', ['push', String(vmid), envPath, '/etc/avero-pulse-agent.env', '--perms', '0600']);
      await run(
        'pct',
        ['push', String(vmid), scriptPath, '/usr/local/sbin/avero-pulse-agent-bootstrap.sh', '--perms', '0755'],
      );
      await run('pct', ['exec', String(vmid), '--', '/bin/sh', '/usr/local/sbin/avero-pulse-agent-bootstrap.sh']);
    } finally {
      await fs.unlink(envPath).catch(() => {});
      await fs.unlink(scriptPath).catch(() => {});
    }
  }

  function vmConfig(spec, hostname, marker, agentCloudInitRef) {
    return {
      name: hostname,
      cores: toPositiveInt(spec.cores),
      memory: toPositiveInt(spec.memoryMb),
      description: marker.description,
      tags: marker.tags,
      agent: 1,
      ciuser: spec.cloudInitUser || spec.username,
      nameserver: spec.nameserver,
      searchdomain: spec.searchdomain,
      sshkeys: sshKeysValue(spec.sshKeys),
      cicustom: mergeCiCustom(spec.cicustom, agentCloudInitRef),
      ...normalizeVmNetworkConfig(spec.networkConfig),
    };
  }

  function lxcConfig(vmid, spec, hostname, marker, template) {
    const storagePool = trim(spec.storagePool) || defaultStorage;
    const config = {
      vmid,
      ostemplate: template,
      hostname,
      cores: toPositiveInt(spec.cores),
      memory: toPositiveInt(spec.memoryMb),
      description: marker.description,
      tags: marker.tags,
      unprivileged: spec.unprivileged === false ? 0 : 1,
      'ssh-public-keys': sshKeysValue(spec.sshKeys),
      ...normalizeLxcNetworkConfig(spec.networkConfig),
    };

    if (spec.rootfs) {
      config.rootfs = spec.rootfs;
    } else if (spec.diskGb) {
      if (!storagePool) {
        throw new Error('storagePool or PROVISION_DEFAULT_STORAGE is required for LXC diskGb');
      }
      config.rootfs = `${storagePool}:${spec.diskGb}`;
    }

    return config;
  }

  async function getApiResources() {
    return apiRequest('get', '/cluster/resources', { type: 'vm' });
  }

  async function getCliResources() {
    return runJson('pvesh', [
      'get',
      '/cluster/resources',
      '--type',
      'vm',
      '--output-format',
      'json',
    ]);
  }

  async function listResources() {
    return api ? getApiResources() : getCliResources();
  }

  async function getResource(vmid, type) {
    const resources = await listResources();
    return (resources || []).find((resource) => {
      return String(resource.vmid) === String(vmid) && (!type || resource.type === type);
    }) || null;
  }

  async function getApiConfig(type, resourceNode, vmid) {
    return apiRequest(
      'get',
      `/nodes/${pathPart(resourceNode)}/${endpointForType(type)}/${pathPart(vmid)}/config`,
    );
  }

  async function getCliConfig(type, resourceNode, vmid) {
    try {
      return await runJson('pvesh', [
        'get',
        `/nodes/${resourceNode}/${endpointForType(type)}/${vmid}/config`,
        '--output-format',
        'json',
      ]);
    } catch (_) {
      const command = type === 'qemu' ? 'qm' : 'pct';
      return parseCliConfig(await run(command, ['config', String(vmid)]));
    }
  }

  async function getConfig(type, resourceNode, vmid) {
    return api ? getApiConfig(type, resourceNode, vmid) : getCliConfig(type, resourceNode, vmid);
  }

  async function getApiIp(type, resourceNode, vmid) {
    if (type !== 'qemu') {
      return null;
    }
    try {
      const data = await apiRequest(
        'get',
        `/nodes/${pathPart(resourceNode)}/qemu/${pathPart(vmid)}/agent/network-get-interfaces`,
      );
      return extractIpFromAgentInterfaces(data);
    } catch (_) {
      return null;
    }
  }

  async function getCliIp(type, vmid) {
    if (type !== 'qemu') {
      return null;
    }
    try {
      const data = await runJson('qm', ['guest', 'cmd', String(vmid), 'network-get-interfaces']);
      return extractIpFromAgentInterfaces(data);
    } catch (_) {
      return null;
    }
  }

  async function getInstanceIp(type, resourceNode, vmid) {
    return api ? getApiIp(type, resourceNode, vmid) : getCliIp(type, vmid);
  }

  async function resultFromResource(resource) {
    const type = resource.type;
    const resourceNode = resource.node || node;
    let current = null;
    try {
      current = await getCurrentStatus(type, resourceNode, resource.vmid);
    } catch (err) {
      warn(`Failed to read status for existing ${instanceIdFor(type, resource.vmid)}: ${err.message}`);
    }

    return {
      instanceId: instanceIdFor(type, resource.vmid),
      ip: await getInstanceIp(type, resourceNode, resource.vmid),
      state: current?.status || resource.status || 'unknown',
    };
  }

  async function findInstanceByRequestId(requestId, shape) {
    const type = normalizeShape(shape) === 'vm' ? 'qemu' : 'lxc';
    const resources = await listResources();

    for (const resource of resources || []) {
      if (resource.type !== type) {
        continue;
      }

      try {
        const config = await getConfig(resource.type, resource.node || node, resource.vmid);
        if (descriptionHasRequestId(config, requestId)) {
          log(`Found existing ${instanceIdFor(resource.type, resource.vmid)} for requestId=${requestId}`);
          return resultFromResource(resource);
        }
      } catch (err) {
        warn(`Failed to inspect ${instanceIdFor(resource.type, resource.vmid)} for idempotency: ${err.message}`);
      }
    }

    return null;
  }

  async function createVm(spec, requestId, onProgress) {
    const vmid = await nextId();
    const template = templateFor('vm', spec);
    const hostname = trim(spec.hostname) || `avero-vm-${vmid}`;
    const marker = buildMarker(requestId);
    const storagePool = trim(spec.storagePool) || defaultStorage;
    const agent = normalizeAgentSpec(spec);
    const agentCloudInitRef = agent ? await writeAgentCloudInitSnippet(agent, requestId) : null;

    onProgress?.('cloning');
    if (api) {
      const cloneParams = {
        newid: vmid,
        name: hostname,
        full: 1,
        storage: storagePool || undefined,
        description: marker.description,
      };
      await waitForApiTask(await apiRequest(
        'post',
        `/nodes/${pathPart(node)}/qemu/${pathPart(template)}/clone`,
        cloneParams,
      ));

      onProgress?.('configuring');
      const configResult = await apiRequest(
        'post',
        `/nodes/${pathPart(node)}/qemu/${pathPart(vmid)}/config`,
        vmConfig(spec, hostname, marker, agentCloudInitRef),
      );
      await waitForApiTask(configResult);
      if (spec.diskGb) {
        await waitForApiTask(await apiRequest(
          'put',
          `/nodes/${pathPart(node)}/qemu/${pathPart(vmid)}/resize`,
          {
            disk: spec.disk || 'scsi0',
            size: `${spec.diskGb}G`,
          },
        ));
      }

      onProgress?.('starting');
      await waitForApiTask(await apiRequest(
        'post',
        `/nodes/${pathPart(node)}/qemu/${pathPart(vmid)}/status/start`,
      ));
    } else {
      const cloneArgs = ['clone', String(template), String(vmid), '--name', hostname, '--full', '1'];
      if (storagePool) cloneArgs.push('--storage', storagePool);
      cloneArgs.push('--description', marker.description);
      await run('qm', cloneArgs);

      onProgress?.('configuring');
      const config = vmConfig(spec, hostname, marker, agentCloudInitRef);
      config.agent = 'enabled=1';
      const setArgs = ['set', String(vmid)];
      for (const [key, value] of Object.entries(config)) {
        if (value === undefined || value === null || value === '') continue;
        setArgs.push(`--${key}`, String(value));
      }
      await run('qm', setArgs);
      if (spec.diskGb) {
        await run('qm', ['resize', String(vmid), spec.disk || 'scsi0', `${spec.diskGb}G`]);
      }

      onProgress?.('starting');
      await run('qm', ['start', String(vmid)]);
    }

    return {
      instanceId: instanceIdFor('qemu', vmid),
      ip: await getInstanceIp('qemu', node, vmid),
      state: 'running',
    };
  }

  async function createLxc(spec, requestId, onProgress) {
    const vmid = await nextId();
    const template = templateFor('lxc', spec);
    const hostname = trim(spec.hostname) || `avero-lxc-${vmid}`;
    const marker = buildMarker(requestId);
    const agent = normalizeAgentSpec(spec);
    const config = lxcConfig(vmid, spec, hostname, marker, template);

    onProgress?.('creating');
    if (api) {
      await waitForApiTask(await apiRequest(
        'post',
        `/nodes/${pathPart(node)}/lxc`,
        config,
      ));

      onProgress?.('starting');
      await waitForApiTask(await apiRequest(
        'post',
        `/nodes/${pathPart(node)}/lxc/${pathPart(vmid)}/status/start`,
      ));
    } else {
      const createArgs = ['create', String(vmid), String(template)];
      for (const [key, value] of Object.entries(config)) {
        if (key === 'vmid' || key === 'ostemplate') continue;
        if (value === undefined || value === null || value === '') continue;
        createArgs.push(`--${key}`, String(value));
      }
      await run('pct', createArgs);

      onProgress?.('starting');
      await run('pct', ['start', String(vmid)]);
    }

    if (agent) {
      onProgress?.('configuring');
      await injectLxcAgent(vmid, agent, requestId);
    }

    return {
      instanceId: instanceIdFor('lxc', vmid),
      ip: await getInstanceIp('lxc', node, vmid),
      state: 'running',
    };
  }

  async function stopInstance(type, resourceNode, vmid) {
    try {
      if (api) {
        const upid = await apiRequest(
          'post',
          `/nodes/${pathPart(resourceNode)}/${endpointForType(type)}/${pathPart(vmid)}/status/stop`,
        );
        await waitForApiTask(upid, 10 * 60 * 1000, resourceNode);
        return;
      }
      await run(type === 'qemu' ? 'qm' : 'pct', ['stop', String(vmid)]);
    } catch (err) {
      const message = String(err.message || '').toLowerCase();
      if (!message.includes('not running') && !message.includes('already stopped')) {
        throw err;
      }
    }
  }

  async function removeInstance(type, resourceNode, vmid) {
    if (api) {
      const upid = await apiRequest(
        'delete',
        `/nodes/${pathPart(resourceNode)}/${endpointForType(type)}/${pathPart(vmid)}`,
        { purge: 1, 'destroy-unreferenced-disks': 1 },
      );
      await waitForApiTask(upid, 10 * 60 * 1000, resourceNode);
      return;
    }
    await run(type === 'qemu' ? 'qm' : 'pct', ['destroy', String(vmid), '--purge', '1']);
  }

  async function getCurrentStatus(type, resourceNode, vmid) {
    if (api) {
      return apiRequest(
        'get',
        `/nodes/${pathPart(resourceNode)}/${endpointForType(type)}/${pathPart(vmid)}/status/current`,
      );
    }
    return runJson('pvesh', [
      'get',
      `/nodes/${resourceNode}/${endpointForType(type)}/${vmid}/status/current`,
      '--output-format',
      'json',
    ]);
  }

  return {
    async createInstance({ shape, spec, requestId, onProgress }) {
      const normalizedShape = normalizeShape(shape);
      const normalizedSpec = spec && typeof spec === 'object' ? spec : {};
      const existing = await findInstanceByRequestId(requestId, normalizedShape);
      if (existing) {
        return existing;
      }

      return normalizedShape === 'vm'
        ? createVm(normalizedSpec, requestId, onProgress)
        : createLxc(normalizedSpec, requestId, onProgress);
    },

    async destroyInstance(instanceId) {
      const parsed = parseInstanceId(instanceId);
      const resource = await getResource(parsed.vmid, parsed.type);
      if (!resource) {
        return { ok: true, found: false };
      }

      const type = resource.type;
      const resourceNode = resource.node || node;
      const config = await getConfig(type, resourceNode, parsed.vmid);
      if (!hasManagedMarker(config)) {
        return {
          ok: false,
          found: true,
          error: 'refused: not avero-managed',
        };
      }

      await stopInstance(type, resourceNode, parsed.vmid);
      await removeInstance(type, resourceNode, parsed.vmid);
      return { ok: true, found: true };
    },

    async getInstanceStatus(instanceId) {
      const parsed = parseInstanceId(instanceId);
      const resource = await getResource(parsed.vmid, parsed.type);
      if (!resource) {
        throw new Error('instance not found');
      }

      const current = await getCurrentStatus(resource.type, resource.node || node, parsed.vmid);
      return {
        state: current?.status || resource.status || 'unknown',
        stats: statusStats(current || resource),
      };
    },

    async getCapacity() {
      if (api) {
        const status = await apiRequest('get', `/nodes/${pathPart(node)}/status`);
        const storage = await apiRequest('get', `/nodes/${pathPart(node)}/storage`);
        return buildCapacity(node, status, storage);
      }

      const status = await runJson('pvesh', [
        'get',
        `/nodes/${node}/status`,
        '--output-format',
        'json',
      ]);
      const storage = await runJson('pvesh', [
        'get',
        `/nodes/${node}/storage`,
        '--output-format',
        'json',
      ]);
      return buildCapacity(node, status, storage);
    },
  };
};
