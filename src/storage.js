/**
 * Storage telemetry collector.
 *
 * Answers the question `totalDisk`/`freeDisk` cannot: *what* is occupying the
 * disk. Three classes of consumer need three different remediations, and they
 * are indistinguishable from a single "used bytes" number:
 *
 *   - reclaimable garbage  → prune (docker images, build cache, logs)
 *   - ghost space          → restart the process holding the fd
 *   - real data            → alert a human; no script should delete it
 *
 * "Ghost space" is disk held by files that were unlinked while a process still
 * had them open. The kernel frees the blocks only when the last fd closes, so
 * `df` counts them and `du` can never see them — deleting more files does
 * nothing, and only a process restart reclaims the space.
 *
 * Collection is read-only. This module never deletes, truncates or restarts
 * anything; remediation belongs in versioned skills that run over SSH.
 */
const fs = require('fs');
const http = require('http');
const { execFile } = require('child_process');

const DELETED_SUFFIX = ' (deleted)';

// Filesystems that hold real bytes. Pseudo (proc/sysfs/cgroup), network and
// squashfs (snap) mounts are noise for capacity planning.
const REAL_FILESYSTEMS = new Set([
  'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'jfs', 'reiserfs', 'vfat', 'ntfs',
]);

function createStorageCollector({ env = process.env, log = console.log, warn = console.warn } = {}) {
  const readInt = (name, fallback) => {
    const value = parseInt(env[name] || '', 10);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };

  const ENABLED = env.INCLUDE_STORAGE !== 'false';
  const INTERVAL_MS = readInt('STORAGE_INTERVAL_MS', 300000); // 5 min
  const DEEP_INTERVAL_MS = readInt('STORAGE_DEEP_INTERVAL_MS', 21600000); // 6 h
  const TOP_DIRS_LIMIT = readInt('STORAGE_TOP_DIRS_LIMIT', 15);
  const TOP_DIRS_DEPTH = readInt('STORAGE_TOP_DIRS_DEPTH', 2);
  const TOP_HOLDERS_LIMIT = readInt('STORAGE_TOP_HOLDERS_LIMIT', 5);
  const TOP_LOGS_LIMIT = readInt('STORAGE_TOP_LOGS_LIMIT', 10);
  const GHOST_MIN_BYTES = readInt('STORAGE_GHOST_MIN_BYTES', 1048576); // ignore <1 MB holders
  const DU_TIMEOUT_MS = readInt('STORAGE_DU_TIMEOUT_MS', 120000);
  const DOCKER_SOCKET = env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
  const DOCKER_TIMEOUT_MS = readInt('STORAGE_DOCKER_TIMEOUT_MS', 10000);

  // When the host root is bind-mounted (recommended), host paths are read
  // through it. Without the mount we still see the correct root filesystem
  // *totals* — an overlay mount reports its backing device — but per-mount
  // detail, container logs and directory walks are unavailable.
  const ROOTFS = env.STORAGE_ROOTFS || (safeExists('/hostfs/etc') ? '/hostfs' : '/');
  const HOSTFS_MOUNTED = ROOTFS !== '/';

  let lastPayload = null;
  let lastHash = null;
  let lastAt = 0;
  let deep = null;
  let deepAt = 0;
  let logged = false;

  function hostPath(p) {
    if (!HOSTFS_MOUNTED) return p;
    return p === '/' ? ROOTFS : `${ROOTFS}${p}`;
  }

  // ── Mounts ────────────────────────────────────────────────────────────────

  // Kernel escapes spaces and friends as octal in the mount table.
  function unescapeMountField(value) {
    return value.replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
  }

  function readMountTable() {
    // /proc/1/mounts is the host's table when the agent runs with pid:host.
    for (const candidate of ['/proc/1/mounts', '/proc/mounts']) {
      try {
        return fs.readFileSync(candidate, 'utf8');
      } catch {
        // try the next one
      }
    }
    return '';
  }

  function statfsBytes(target) {
    if (typeof fs.statfsSync !== 'function') return null; // node < 18.15
    const st = fs.statfsSync(target);
    const blockSize = st.bsize || 4096;
    // Filesystems without an inode table (and non-Linux hosts) report 0 here;
    // that is "not applicable", not "zero inodes".
    const inodesTotal = st.files ? Number(st.files) : null;
    return {
      sizeBytes: st.blocks * blockSize,
      availBytes: st.bavail * blockSize,
      usedBytes: (st.blocks - st.bfree) * blockSize,
      inodesTotal,
      inodesUsed: inodesTotal != null && st.ffree != null ? inodesTotal - Number(st.ffree) : null,
    };
  }

  async function dfBytes(target) {
    const stdout = await execOutput('df', ['-kP', target]);
    const line = stdout.trim().split(/\r?\n/)[1];
    if (!line) return null;
    const cols = line.trim().split(/\s+/);
    const size = Number(cols[1]) * 1024;
    const used = Number(cols[2]) * 1024;
    const avail = Number(cols[3]) * 1024;
    if (!Number.isFinite(size)) return null;
    return { sizeBytes: size, usedBytes: used, availBytes: avail, inodesTotal: null, inodesUsed: null };
  }

  async function measureMount(mountPoint) {
    const target = hostPath(mountPoint);
    try {
      const viaStatfs = statfsBytes(target);
      if (viaStatfs) return viaStatfs;
    } catch {
      // fall through to df
    }
    try {
      return await dfBytes(target);
    } catch {
      return null;
    }
  }

  async function collectMounts() {
    const seen = new Set();
    const candidates = [];

    for (const line of readMountTable().split('\n')) {
      const parts = line.split(' ');
      if (parts.length < 3) continue;
      const device = unescapeMountField(parts[0]);
      const mountPoint = unescapeMountField(parts[1]);
      const fsType = parts[2];
      if (!device.startsWith('/dev/')) continue;
      if (!REAL_FILESYSTEMS.has(fsType)) continue;
      if (seen.has(mountPoint)) continue;
      seen.add(mountPoint);
      candidates.push({ device, mountPoint, fsType });
    }

    // No usable mount table (or no host mount): report the root filesystem,
    // which an overlay still resolves to the real backing device.
    if (candidates.length === 0) {
      candidates.push({ device: null, mountPoint: '/', fsType: null });
    }

    const mounts = [];
    for (const candidate of candidates) {
      const measured = await measureMount(candidate.mountPoint);
      if (!measured || !measured.sizeBytes) continue;
      const usedPct = Math.round((measured.usedBytes / measured.sizeBytes) * 100);
      const inodesUsedPct =
        measured.inodesTotal && measured.inodesUsed != null
          ? Math.round((measured.inodesUsed / measured.inodesTotal) * 100)
          : null;
      mounts.push({
        mount: candidate.mountPoint,
        fs: candidate.device,
        type: candidate.fsType,
        sizeBytes: measured.sizeBytes,
        usedBytes: measured.usedBytes,
        availBytes: measured.availBytes,
        usedPct,
        inodesTotal: measured.inodesTotal,
        inodesUsed: measured.inodesUsed,
        inodesUsedPct,
      });
    }

    return mounts.sort((a, b) => b.sizeBytes - a.sizeBytes);
  }

  // ── Ghost space (deleted but still open) ──────────────────────────────────

  function readFirstLine(file) {
    try {
      return fs.readFileSync(file, 'utf8').split('\n')[0].trim();
    } catch {
      return null;
    }
  }

  function containerIdForPid(pid) {
    let cgroup;
    try {
      cgroup = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8');
    } catch {
      return null;
    }
    const match = cgroup.match(/[0-9a-f]{64}/) || cgroup.match(/docker[-/]([0-9a-f]{12,})/);
    if (!match) return null;
    return (match[1] || match[0]).slice(0, 64);
  }

  /**
   * Walks /proc/<pid>/fd looking for open file descriptors whose target has
   * been unlinked — the same check as `lsof +L1`, without shelling out.
   *
   * Requires CAP_SYS_PTRACE to inspect processes owned by other users; without
   * it the walk silently sees only its own, so deniedPids is reported and the
   * result must be read as a lower bound.
   */
  function collectGhost(containerNamesById) {
    const holders = new Map();
    const countedInodes = new Set();
    let scannedPids = 0;
    let deniedPids = 0;
    let heldBytes = 0;
    let files = 0;

    let pids;
    try {
      pids = fs.readdirSync('/proc');
    } catch (err) {
      return { error: err.message };
    }

    for (const entry of pids) {
      if (!/^\d+$/.test(entry)) continue;
      scannedPids++;

      let fds;
      try {
        fds = fs.readdirSync(`/proc/${entry}/fd`);
      } catch (err) {
        if (err.code === 'EACCES' || err.code === 'EPERM') deniedPids++;
        continue; // ESRCH just means the process exited mid-walk
      }

      for (const fd of fds) {
        const fdPath = `/proc/${entry}/fd/${fd}`;
        let target;
        try {
          target = fs.readlinkSync(fdPath);
        } catch {
          continue;
        }
        if (!target.endsWith(DELETED_SUFFIX)) continue;

        const filePath = target.slice(0, -DELETED_SUFFIX.length);
        // memfd lives in RAM and /dev nodes are not disk usage.
        if (!filePath.startsWith('/') || filePath.startsWith('/memfd:') || filePath.startsWith('/dev/')) {
          continue;
        }

        let stat;
        try {
          stat = fs.statSync(fdPath); // follows the fd to the unlinked inode
        } catch {
          continue;
        }
        if (stat.nlink !== 0) continue; // still has a directory entry

        // One inode can be held by many fds and many processes; the blocks are
        // only allocated once, so attribute them once.
        const inodeKey = `${stat.dev}:${stat.ino}`;
        if (countedInodes.has(inodeKey)) continue;
        countedInodes.add(inodeKey);

        // Allocated blocks, not apparent size — sparse files would overstate.
        const bytes = typeof stat.blocks === 'number' ? stat.blocks * 512 : stat.size;
        heldBytes += bytes;
        files++;

        const pid = Number(entry);
        const holder = holders.get(pid) || { pid, heldBytes: 0, files: 0, sample: filePath };
        holder.heldBytes += bytes;
        holder.files++;
        holders.set(pid, holder);
      }
    }

    const topHolders = [...holders.values()]
      .filter((holder) => holder.heldBytes >= GHOST_MIN_BYTES)
      .sort((a, b) => b.heldBytes - a.heldBytes)
      .slice(0, TOP_HOLDERS_LIMIT)
      .map((holder) => {
        const containerId = containerIdForPid(holder.pid);
        return {
          ...holder,
          comm: readFirstLine(`/proc/${holder.pid}/comm`),
          containerId: containerId ? containerId.slice(0, 12) : null,
          container: containerId ? containerNamesById.get(containerId) ?? null : null,
        };
      });

    return {
      heldBytes,
      files,
      processes: holders.size,
      topHolders,
      scannedPids,
      deniedPids, // > 0 means heldBytes is a lower bound (missing CAP_SYS_PTRACE)
    };
  }

  // ── Docker ────────────────────────────────────────────────────────────────

  function dockerGet(path) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { socketPath: DOCKER_SOCKET, path, method: 'GET', timeout: DOCKER_TIMEOUT_MS },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
              reject(new Error(`docker ${path} returned ${res.statusCode}`));
              return;
            }
            try {
              resolve(JSON.parse(body));
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error(`docker ${path} timed out`)));
      req.on('error', reject);
      req.end();
    });
  }

  async function collectContainerNames() {
    const names = new Map();
    try {
      const containers = await dockerGet('/containers/json?all=1');
      for (const container of containers) {
        const name = Array.isArray(container.Names) && container.Names[0]
          ? container.Names[0].replace(/^\//, '')
          : container.Id.slice(0, 12);
        names.set(container.Id, name);
      }
    } catch {
      // Docker is optional; ghost/log attribution degrades to ids.
    }
    return names;
  }

  async function collectDockerUsage() {
    const df = await dockerGet('/system/df');
    const images = Array.isArray(df.Images) ? df.Images : [];
    const containers = Array.isArray(df.Containers) ? df.Containers : [];
    const volumes = Array.isArray(df.Volumes) ? df.Volumes : [];
    const buildCache = Array.isArray(df.BuildCache) ? df.BuildCache : [];

    const sum = (list, pick) => list.reduce((total, item) => total + (pick(item) || 0), 0);

    return {
      // LayersSize is the deduplicated on-disk total; summing Image.Size double
      // counts shared layers, so it is only used for the reclaimable estimate
      // (same approximation the docker CLI makes).
      imagesBytes: df.LayersSize || 0,
      imagesReclaimableBytes: sum(images.filter((image) => !image.Containers || image.Containers <= 0), (i) => i.Size),
      imagesCount: images.length,
      containersBytes: sum(containers, (c) => c.SizeRw),
      containersCount: containers.length,
      volumesBytes: sum(volumes, (v) => v.UsageData && v.UsageData.Size > 0 ? v.UsageData.Size : 0),
      volumesReclaimableBytes: sum(
        volumes.filter((v) => v.UsageData && v.UsageData.RefCount === 0),
        (v) => (v.UsageData.Size > 0 ? v.UsageData.Size : 0),
      ),
      volumesCount: volumes.length,
      buildCacheBytes: sum(buildCache, (b) => b.Size),
      buildCacheReclaimableBytes: sum(buildCache.filter((b) => !b.InUse), (b) => b.Size),
    };
  }

  /**
   * Container stdout/stderr logs. `docker system df` does not count these and
   * `docker prune` never removes them, so an uncapped json-file driver can
   * quietly own the disk while every Docker-side number looks healthy.
   */
  function collectContainerLogs(containerNamesById) {
    const base = hostPath('/var/lib/docker/containers');
    let dirs;
    try {
      dirs = fs.readdirSync(base);
    } catch (err) {
      return { error: err.code === 'ENOENT' && !HOSTFS_MOUNTED ? 'host root not mounted' : err.message };
    }

    let totalBytes = 0;
    const perContainer = [];

    for (const dir of dirs) {
      let entries;
      try {
        entries = fs.readdirSync(`${base}/${dir}`);
      } catch {
        continue;
      }
      let bytes = 0;
      for (const entry of entries) {
        if (!entry.includes('-json.log')) continue; // includes rotated .1 .2 …
        try {
          bytes += fs.statSync(`${base}/${dir}/${entry}`).size;
        } catch {
          // container removed mid-walk
        }
      }
      if (bytes <= 0) continue;
      totalBytes += bytes;
      perContainer.push({
        containerId: dir.slice(0, 12),
        name: containerNamesById.get(dir) ?? dir.slice(0, 12),
        bytes,
      });
    }

    return {
      totalBytes,
      top: perContainer.sort((a, b) => b.bytes - a.bytes).slice(0, TOP_LOGS_LIMIT),
    };
  }

  // ── Directory walk (slow tier) ────────────────────────────────────────────

  function execOutput(command, args, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      execFile(command, args, { maxBuffer: 1024 * 1024 * 10, timeout: timeoutMs }, (error, stdout) => {
        // du exits non-zero on unreadable subdirectories but still prints
        // everything it could measure, which is good enough.
        if (error && !stdout) {
          reject(error);
          return;
        }
        resolve(stdout.toString());
      });
    });
  }

  async function collectTopDirs() {
    const root = hostPath('/');
    const stdout = await execOutput('du', ['-xk', '-d', String(TOP_DIRS_DEPTH), root], DU_TIMEOUT_MS);
    const dirs = [];

    for (const line of stdout.split('\n')) {
      const match = line.match(/^(\d+)\s+(.*)$/);
      if (!match) continue;
      const bytes = Number(match[1]) * 1024;
      let path = match[2];
      if (HOSTFS_MOUNTED && path.startsWith(ROOTFS)) path = path.slice(ROOTFS.length) || '/';
      if (path === '/' || !path) continue; // the total, not a finding
      dirs.push({ path, bytes });
    }

    return dirs.sort((a, b) => b.bytes - a.bytes).slice(0, TOP_DIRS_LIMIT);
  }

  // ── Orchestration ─────────────────────────────────────────────────────────

  async function collectFresh() {
    const errors = [];
    const containerNames = await collectContainerNames();

    const mounts = await collectMounts().catch((err) => {
      errors.push(`mounts: ${err.message}`);
      return [];
    });

    let ghost = null;
    try {
      ghost = collectGhost(containerNames);
      if (ghost.error) {
        errors.push(`ghost: ${ghost.error}`);
        ghost = null;
      }
    } catch (err) {
      errors.push(`ghost: ${err.message}`);
    }

    let docker = null;
    try {
      docker = await collectDockerUsage();
    } catch (err) {
      errors.push(`docker: ${err.message}`);
    }

    let logs = null;
    try {
      logs = collectContainerLogs(containerNames);
      if (logs.error) {
        errors.push(`containerLogs: ${logs.error}`);
        logs = null;
      }
    } catch (err) {
      errors.push(`containerLogs: ${err.message}`);
    }

    if (docker && logs) docker.containerLogsBytes = logs.totalBytes;

    const now = Date.now();
    if (!deep || now - deepAt >= DEEP_INTERVAL_MS) {
      try {
        deep = { topDirs: await collectTopDirs(), collectedAt: now };
        deepAt = now;
      } catch (err) {
        errors.push(`topDirs: ${err.message}`);
        deepAt = now; // do not retry an expensive failing walk every cycle
      }
    }

    const root = mounts.find((mount) => mount.mount === '/') || mounts[0] || null;

    return {
      mounts,
      root: root
        ? { sizeBytes: root.sizeBytes, usedBytes: root.usedBytes, availBytes: root.availBytes, usedPct: root.usedPct }
        : null,
      ghost,
      docker,
      containerLogs: logs,
      topDirs: deep ? deep.topDirs : null,
      topDirsAt: deep ? deep.collectedAt : null,
      hostfsMounted: HOSTFS_MOUNTED,
      errors: errors.length ? errors : null,
      sampledAt: now,
    };
  }

  /**
   * Returns the storage block, or `{ same: true }` when nothing changed since
   * the last emission — matching the convention the other collectors use.
   */
  async function collect() {
    if (!ENABLED) return null;

    const now = Date.now();
    if (lastAt && now - lastAt < INTERVAL_MS) {
      return lastHash ? { same: true } : null;
    }

    try {
      const payload = await collectFresh();
      lastAt = now;

      // sampledAt always differs; compare the substance instead.
      const { sampledAt, ...substance } = payload;
      const hash = JSON.stringify(substance);
      if (hash === lastHash) return { same: true };

      lastHash = hash;
      lastPayload = payload;

      if (!logged) {
        logged = true;
        const held = payload.ghost ? `${(payload.ghost.heldBytes / 1048576).toFixed(1)} MB` : 'n/a';
        log(
          `[STORAGE] Collector active: rootfs=${ROOTFS} hostfsMounted=${HOSTFS_MOUNTED} ` +
            `mounts=${payload.mounts.length} ghostHeld=${held} interval=${INTERVAL_MS}ms`,
        );
        if (payload.ghost && payload.ghost.deniedPids > 0) {
          warn(
            `[STORAGE] ${payload.ghost.deniedPids} process(es) unreadable — ghost totals are a lower bound. ` +
              'Add cap_add: [SYS_PTRACE] to the agent container for full attribution.',
          );
        }
        if (!HOSTFS_MOUNTED) {
          warn('[STORAGE] Host root not mounted — per-mount detail, container log sizes and directory walk are unavailable.');
        }
        if (payload.errors) warn(`[STORAGE] Partial collection: ${payload.errors.join('; ')}`);
      }

      return payload;
    } catch (err) {
      warn('[STORAGE] Collection failed:', err.message);
      return lastHash ? { same: true } : null;
    }
  }

  return { collect, enabled: ENABLED, rootfs: ROOTFS, hostfsMounted: HOSTFS_MOUNTED };
}

function safeExists(path) {
  try {
    return fs.existsSync(path);
  } catch {
    return false;
  }
}

module.exports = createStorageCollector;
