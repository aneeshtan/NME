/**
 * Host, container, and process resources.
 *
 * Three layers that are easy to confuse and answer different questions.
 *
 * The **process** numbers (heap, RSS) say whether this Node service is leaking.
 * The **container** numbers say how close it is to the cgroup limit that Docker
 * will kill it at — a limit set in infra/docker-compose.yml, not by the kernel,
 * and the most likely hard failure in the stack. The **host** numbers say
 * whether the box itself is saturated, which on this deployment is usually
 * LiveKit rather than anything here, because media never touches this process.
 *
 * Everything below degrades to `null` when it cannot be read. The cgroup files
 * do not exist outside Linux and differ between cgroup v1 and v2, and a
 * dashboard that throws on a developer's laptop is worse than one that says
 * "not available".
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';

export interface SystemSnapshot {
  process: {
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
    externalMb: number;
    nodeVersion: string;
  };
  container: {
    /** Bytes the cgroup allows, or `null` when unlimited or unreadable. */
    memoryLimitMb: number | null;
    memoryUsedMb: number | null;
    /** Percent of the limit in use — what Docker kills on. */
    memoryPercent: number | null;
    /** Cores the cgroup allows, e.g. 1 for `cpus: '1.0'`. */
    cpuLimit: number | null;
  };
  host: {
    /** One, five, and fifteen minute load averages. */
    load: [number, number, number];
    cores: number;
    /** Load over cores: above 1 means the run queue is backing up. */
    loadPerCore: number;
    memoryTotalMb: number;
    memoryFreeMb: number;
    uptimeSeconds: number;
  };
}

/**
 * cgroup files are read from disk, and this is called on every dashboard poll.
 * Five seconds is far shorter than anything an operator would notice and long
 * enough that the read is not on a hot path.
 */
const CACHE_MS = 5_000;
let cached: { at: number; value: SystemSnapshot['container'] } | null = null;

const MB = 1024 * 1024;

async function readNumber(path: string): Promise<number | null> {
  try {
    const raw = (await readFile(path, 'utf8')).trim();
    // cgroup v2 writes the literal `max` for "no limit".
    if (raw === 'max' || raw === '') return null;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function containerStats(): Promise<SystemSnapshot['container']> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.value;

  // cgroup v2 first: it is what every current distribution boots with, and its
  // paths are unambiguous. v1 is the fallback for older hosts.
  const [limitV2, usedV2, cpuMaxV2] = await Promise.all([
    readNumber('/sys/fs/cgroup/memory.max'),
    readNumber('/sys/fs/cgroup/memory.current'),
    readFile('/sys/fs/cgroup/cpu.max', 'utf8').catch(() => ''),
  ]);

  let memoryLimit = limitV2;
  let memoryUsed = usedV2;
  let cpuLimit = parseCpuMax(cpuMaxV2);

  if (memoryLimit === null && memoryUsed === null) {
    const [limitV1, usedV1, quota, period] = await Promise.all([
      readNumber('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
      readNumber('/sys/fs/cgroup/memory/memory.usage_in_bytes'),
      readNumber('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'),
      readNumber('/sys/fs/cgroup/cpu/cpu.cfs_period_us'),
    ]);

    memoryLimit = limitV1;
    memoryUsed = usedV1;
    if (quota !== null && quota > 0 && period !== null && period > 0) cpuLimit = quota / period;
  }

  // An unlimited cgroup reports a sentinel near the top of the address space
  // rather than nothing at all; treated as "no limit" so the dashboard does not
  // claim the container has eight exabytes of headroom.
  if (memoryLimit !== null && memoryLimit > 1e15) memoryLimit = null;

  const value: SystemSnapshot['container'] = {
    memoryLimitMb: memoryLimit === null ? null : Math.round(memoryLimit / MB),
    memoryUsedMb: memoryUsed === null ? null : Math.round(memoryUsed / MB),
    memoryPercent:
      memoryLimit && memoryUsed ? Math.round((memoryUsed / memoryLimit) * 1000) / 10 : null,
    cpuLimit,
  };

  cached = { at: now, value };
  return value;
}

/** cgroup v2 writes `"<quota> <period>"`, or `"max <period>"` when unlimited. */
function parseCpuMax(raw: string): number | null {
  const [quota, period] = raw.trim().split(/\s+/);
  if (!quota || quota === 'max' || !period) return null;

  const quotaValue = Number.parseInt(quota, 10);
  const periodValue = Number.parseInt(period, 10);
  if (!Number.isFinite(quotaValue) || !Number.isFinite(periodValue) || periodValue <= 0) {
    return null;
  }
  return Math.round((quotaValue / periodValue) * 100) / 100;
}

export async function systemSnapshot(): Promise<SystemSnapshot> {
  const memory = process.memoryUsage();
  const load = os.loadavg();
  const cores = os.cpus().length || 1;

  return {
    process: {
      rssMb: Math.round(memory.rss / MB),
      heapUsedMb: Math.round(memory.heapUsed / MB),
      heapTotalMb: Math.round(memory.heapTotal / MB),
      externalMb: Math.round(memory.external / MB),
      nodeVersion: process.versions.node,
    },
    container: await containerStats(),
    host: {
      load: [round(load[0] ?? 0), round(load[1] ?? 0), round(load[2] ?? 0)],
      cores,
      loadPerCore: round((load[0] ?? 0) / cores),
      // Host figures, not the container's: /proc/meminfo is not namespaced, so
      // these describe the whole box — which is the useful reading, since
      // LiveKit is the process that will exhaust it.
      memoryTotalMb: Math.round(os.totalmem() / MB),
      memoryFreeMb: Math.round(os.freemem() / MB),
      uptimeSeconds: Math.round(os.uptime()),
    },
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
