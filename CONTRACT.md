# Pulse Client Provider Contract

This document specifies the additive provider-mode contract for the Pulse client.
The existing host reporting contract is unchanged when `PROVIDER_MODE=false`.

All socket messages use the existing Socket.IO event:

```text
avero:msg
```

## Existing Host Messages

The client continues to emit the existing messages without shape changes:

- `host.register`
- `host.metrics`

The metrics `{ "same": true }` optimization, resource reporting endpoint, token and `hostKey`
envelope fields, reconnection behavior, and local health endpoint are unchanged.

## Storage Telemetry

Agent 1.5.0 adds a `storage` block to `host.metrics`. The legacy `totalDisk` and
`freeDisk` fields are unchanged and still emitted every tick.

`storage` refreshes on `STORAGE_INTERVAL_MS` (default 5 minutes) and follows the
existing `{ "same": true }` convention between refreshes. `topDirs` is carried
forward from the last deep collection (`STORAGE_DEEP_INTERVAL_MS`, default 6 hours)
because a `du` walk is too expensive to run on the metrics interval.

```json
{
  "mounts": [
    {
      "mount": "/",
      "fs": "/dev/root",
      "type": "ext4",
      "sizeBytes": 11400000000,
      "usedBytes": 7493992448,
      "availBytes": 3906007552,
      "usedPct": 66,
      "inodesTotal": 1310720,
      "inodesUsed": 412337,
      "inodesUsedPct": 31
    }
  ],
  "root": { "sizeBytes": 11400000000, "usedBytes": 7493992448, "availBytes": 3906007552, "usedPct": 66 },
  "ghost": {
    "heldBytes": 3600000000,
    "files": 4,
    "processes": 1,
    "topHolders": [
      {
        "pid": 1494,
        "comm": "mysqld",
        "containerId": "a1b2c3d4e5f6",
        "container": "pool1-mysql",
        "heldBytes": 3600000000,
        "files": 4,
        "sample": "/tmp/#262499"
      }
    ],
    "scannedPids": 212,
    "deniedPids": 0
  },
  "docker": {
    "imagesBytes": 0,
    "imagesReclaimableBytes": 0,
    "imagesCount": 0,
    "containersBytes": 0,
    "containersCount": 0,
    "volumesBytes": 0,
    "volumesReclaimableBytes": 0,
    "volumesCount": 0,
    "buildCacheBytes": 0,
    "buildCacheReclaimableBytes": 0,
    "containerLogsBytes": 0
  },
  "containerLogs": { "totalBytes": 0, "top": [{ "containerId": "a1b2c3d4e5f6", "name": "api", "bytes": 0 }] },
  "topDirs": [{ "path": "/var/lib/docker", "bytes": 0 }],
  "topDirsAt": 1753430000000,
  "hostfsMounted": true,
  "errors": null,
  "sampledAt": 1753430000000
}
```

### Ghost Space

`ghost` reports disk held by files that were unlinked while a process still had
them open. The kernel frees those blocks only when the last descriptor closes, so
`df` counts them and `du` cannot see them. Deleting more files does not help; only
restarting the holding process does. This is the same check as `lsof +L1`,
performed by walking `/proc/<pid>/fd` for targets marked `(deleted)` with
`nlink == 0`.

Bytes are counted from allocated blocks, and each inode is counted once no matter
how many descriptors or processes hold it.

`memfd:` targets are excluded — they live in RAM, not on disk.

### Collection Requirements

The agent never deletes, truncates or restarts anything. Collection is read-only,
and degrades rather than fails when a requirement is missing:

| Requirement | Unlocks | Without it |
| --- | --- | --- |
| `pid: host` | ghost attribution across host processes | only the agent's own processes are visible |
| `cap_add: SYS_PTRACE` | reading `/proc/<pid>/fd` of other users' processes | `deniedPids > 0`; `heldBytes` is a lower bound |
| `/:/hostfs:ro` | per-mount usage, inodes, container log sizes, `topDirs` | `hostfsMounted: false`; those fields are null |
| `/var/run/docker.sock` | `docker` breakdown and container names | `docker` is null; holders show ids, not names |

Partial failures are reported in `errors` rather than dropping the block, so a
blind spot is visible to the orchestrator instead of looking like healthy zeroes.

`containerLogsBytes` is tracked separately because `docker system df` does not
count container stdout logs and `docker prune` never removes them — an uncapped
`json-file` driver can fill a disk while every Docker-side number looks healthy.

## Provider Capability Advertisement

When `PROVIDER_MODE=true`, the `host.register` payload adds a sibling
`host.capabilities` object:

```json
{
  "canProvision": true,
  "provider": "proxmox",
  "shapes": ["vm", "lxc"]
}
```

The client also registers a provider resource through the existing HTTP endpoint:

```text
POST /infra/resources/register
```

The client currently sends the provider resource as `type: "HOST"` and
`provider: "PROXMOX"`, with `externalId` set to the provider `HOST_KEY`.
The `capabilitiesJson` field contains live Proxmox capacity sampled at runtime:

```json
{
  "canProvision": true,
  "provider": "proxmox",
  "shapes": ["vm", "lxc"],
  "totalVcpu": 32,
  "freeVcpu": 21.5,
  "totalMemoryMb": 131072,
  "freeMemoryMb": 82112,
  "storagePools": {
    "local-lvm": {
      "totalBytes": 1000000000000,
      "freeBytes": 500000000000,
      "usedBytes": 500000000000,
      "active": 1,
      "enabled": 1,
      "content": "rootdir,images"
    }
  }
}
```

This resource refreshes on `RESOURCE_REPORT_INTERVAL_MS` whenever provider mode is enabled.

## Command Auth

Inbound provider commands must include `commandAuthToken`, which the client compares
to its `COMMAND_AUTH_TOKEN` environment variable.

If `COMMAND_AUTH_TOKEN` is unset or the payload token does not match, the client emits
the matching terminal result with `ok: false` and does not execute the command.

This is a placeholder command-channel auth contract pending orchestrator decision.

## Security Boundaries

The `avero-managed` marker is an accident guard, not a security control. It prevents
destroying unrelated VMs by mistake, but anything able to tag or describe a VM could
bypass it. It is not a defense against a hostile actor on the Proxmox host.

`commandAuthToken` is a static shared secret in the message payload. Its security
depends entirely on the transport. It is safe only over WSS/TLS, such as when the
orchestrator URL is `https://`. Over plain WS, it is a replayable bearer token.

## Orchestrator To Pulse Commands

All command messages are sent on `avero:msg`. Every command carries a string
`requestId` generated by the orchestrator. The `requestId` is the idempotency key.

The client ignores commands whose `hostKey` does not match its own `HOST_KEY`.

### `instance.provision`

```json
{
  "type": "instance.provision",
  "requestId": "req_123",
  "hostKey": "provider-host-001",
  "commandAuthToken": "shared-secret",
  "shape": "vm",
  "spec": {
    "template": "9000",
    "cores": 2,
    "memoryMb": 4096,
    "diskGb": 40,
    "storagePool": "local-lvm",
    "hostname": "app-01",
    "sshKeys": ["ssh-ed25519 AAAA... user@example"],
    "networkConfig": {
      "ip": "dhcp"
    },
    "agent": {
      "enabled": true,
      "hostKey": "child-host-key-assigned-by-orchestrator",
      "regToken": "child-registration-token",
      "masterUrl": "https://orchestrator.example",
      "instanceType": "web-server"
    }
  }
}
```

`shape` must be `"vm"` or `"lxc"`.

For VMs, `template` is a Proxmox template VMID. The client clones the template,
sets CPU, memory, optional disk size, cloud-init SSH keys and network config, marks
the guest as Avero-managed, and starts it.

For LXCs, `template` is a Proxmox LXC template reference. The client creates the
container, sets resources, SSH keys and network config, marks it as Avero-managed,
and starts it.

`spec.agent` is optional. If it is absent or `agent.enabled` is false, the provider
provisions the instance without a guest pulse agent. If `agent.enabled` is true, the
provider injects first-boot agent configuration for the guest to install/start pulse.
VM injection uses cloud-init; LXC injection uses container provisioning after the
container starts. The injected env values are:

- `HOST_KEY` from `agent.hostKey`
- `HOST_REG_TOKEN` from `agent.regToken`
- `MASTER_URL` from `agent.masterUrl`
- `INSTANCE_TYPE` from `agent.instanceType`

The orchestrator is the sole authority for child identity. The provider does not mint
child `HOST_KEY` values or registration tokens. Provisioned guests self-register through
the existing guest-host flow and appear as normal hosts.

### `instance.destroy`

```json
{
  "type": "instance.destroy",
  "requestId": "req_124",
  "hostKey": "provider-host-001",
  "commandAuthToken": "shared-secret",
  "instanceId": "vm:101"
}
```

Destroy is idempotent and returns whether the instance existed:

- instance existed, was Avero-managed, and was removed: `ok: true`, `found: true`
- instance was already absent or never existed: `ok: true`, `found: false`
- instance existed but was not Avero-managed: `ok: false`, `found: true`,
  `error: "refused: not avero-managed"`

### `instance.status`

```json
{
  "type": "instance.status",
  "requestId": "req_125",
  "hostKey": "provider-host-001",
  "commandAuthToken": "shared-secret",
  "instanceId": "vm:101"
}
```

`instanceId` may be typed (`vm:101`, `lxc:102`) or a raw Proxmox VMID/CTID.

## Pulse To Orchestrator Results

Every command produces exactly one terminal result for that command delivery.
Terminal results are emitted on `avero:msg` and include `token` and `hostKey`.

### `instance.provision.result`

```json
{
  "type": "instance.provision.result",
  "token": "host-registration-token",
  "requestId": "req_123",
  "hostKey": "provider-host-001",
  "ok": true,
  "instanceId": "vm:101",
  "ip": "10.0.0.51",
  "state": "running"
}
```

Failure shape:

```json
{
  "type": "instance.provision.result",
  "token": "host-registration-token",
  "requestId": "req_123",
  "hostKey": "provider-host-001",
  "ok": false,
  "error": "missing VM template: set spec.template or PROVISION_VM_TEMPLATE"
}
```

### `instance.destroy.result`

```json
{
  "type": "instance.destroy.result",
  "token": "host-registration-token",
  "requestId": "req_124",
  "hostKey": "provider-host-001",
  "ok": true,
  "found": true
}
```

Already absent / never existed shape:

```json
{
  "type": "instance.destroy.result",
  "token": "host-registration-token",
  "requestId": "req_124",
  "hostKey": "provider-host-001",
  "ok": true,
  "found": false
}
```

Refused shape:

```json
{
  "type": "instance.destroy.result",
  "token": "host-registration-token",
  "requestId": "req_124",
  "hostKey": "provider-host-001",
  "ok": false,
  "found": true,
  "error": "refused: not avero-managed"
}
```

### `instance.status.result`

```json
{
  "type": "instance.status.result",
  "token": "host-registration-token",
  "requestId": "req_125",
  "hostKey": "provider-host-001",
  "ok": true,
  "state": "running",
  "stats": {
    "cpu": 0.03,
    "memoryBytes": 1073741824,
    "maxMemoryBytes": 4294967296,
    "diskBytes": 0,
    "maxDiskBytes": 42949672960,
    "uptime": 3600,
    "netInBytes": 1000,
    "netOutBytes": 2000,
    "diskReadBytes": 0,
    "diskWriteBytes": 0
  }
}
```

## Progress Messages

Provisioning may emit optional progress messages before the terminal result:

```json
{
  "type": "instance.provision.progress",
  "token": "host-registration-token",
  "requestId": "req_123",
  "hostKey": "provider-host-001",
  "phase": "cloning"
}
```

Known phases include `accepted`, `cloning`, `creating`, `configuring`, and `starting`.
The orchestrator must not require progress messages for correctness.

## Idempotency

For `instance.provision`, Proxmox is the source of truth. Before creating anything,
the client queries Proxmox for an existing VM/LXC whose description contains the
same `requestId`. If found, the client does not create a duplicate; it re-derives
`instanceId`, `ip`, and `state` from Proxmox and emits a normal successful
`instance.provision.result`. This provision idempotency survives client process
restarts.

The client also keeps a bounded in-memory cache of provider command results by
`requestId` as a same-process optimization. If a duplicate command arrives while
the original command is still running, the duplicate waits for the original result
and then re-emits it. This cache is not the authoritative idempotency mechanism.

## Proxmox Safety Rules

The client allocates VMIDs/CTIDs by querying Proxmox `/cluster/nextid`; it never guesses.

Every created VM/LXC receives a durable marker:

- tag: `avero-managed`
- description containing `avero-managed` and the `requestId`

`destroyInstance` refuses to destroy any existing VM/LXC without this marker and returns:

```json
{
  "ok": false,
  "found": true,
  "error": "refused: not avero-managed"
}
```

## Open Questions For Orchestrator

1. Command-channel auth: provisioning commands are sensitive. The current client requires
   `commandAuthToken` to match `COMMAND_AUTH_TOKEN`. Should the orchestrator adopt this
   shared secret, use signed messages, or authenticate commands through another channel?
2. Provider resource type: the client currently uses `type: "HOST"` with provider
   capabilities. Should the orchestrator introduce `type: "PROVIDER"` instead? Current
   upsert identity is `{ type, externalId }`.
