/**
 * Manual IP blocks.
 *
 * The rate limiter already throttles automatically. This is the layer above it:
 * a human deciding that a particular source should be refused outright, which
 * is the difference between slowing an abuser down and stopping them.
 *
 * ── On the privacy question ──────────────────────────────────────────────────
 *
 * The policy says an IP address is "recorded in operational logs used for rate
 * limiting and abuse handling, as on any web server". Blocking is abuse
 * handling, and it is impossible without holding the address of the thing being
 * blocked — so this is inside what is already disclosed.
 *
 * The distinction that matters is *which* addresses are held. An address
 * appears here only because an operator put it here, after it generated
 * rejections. There is no record of addresses that simply joined meetings; that
 * would be a log of who connected, which is a different thing entirely and is
 * not collected anywhere.
 *
 * Blocks expire. A permanent list would quietly become exactly the durable
 * record this design avoids everywhere else, and addresses are reassigned.
 *
 * Two backends, matching nonceStore: Redis where configured, because a block
 * must hold across every replica, and an in-process map for single-node
 * deployments.
 */
import { Redis } from 'ioredis';

export interface BlockedEntry {
  ip: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface Blocklist {
  isBlocked(ip: string): Promise<boolean>;
  block(ip: string, ttlSeconds: number): Promise<void>;
  unblock(ip: string): Promise<void>;
  list(): Promise<BlockedEntry[]>;
  close(): Promise<void>;
}

const KEY = 'nme:blocked';

/**
 * A sorted set scored by expiry, rather than one key per address with a TTL.
 * Listing is then a single range read instead of a SCAN, and expiry is a single
 * range delete — which matters because the dashboard reads this list on a timer.
 */
class RedisBlocklist implements Blocklist {
  constructor(private readonly redis: Redis) {}

  private async prune(): Promise<void> {
    await this.redis.zremrangebyscore(KEY, '-inf', Date.now());
  }

  async isBlocked(ip: string): Promise<boolean> {
    const score = await this.redis.zscore(KEY, ip);
    if (score === null) return false;
    if (Number(score) <= Date.now()) {
      await this.redis.zrem(KEY, ip);
      return false;
    }
    return true;
  }

  async block(ip: string, ttlSeconds: number): Promise<void> {
    await this.redis.zadd(KEY, Date.now() + ttlSeconds * 1000, ip);
  }

  async unblock(ip: string): Promise<void> {
    await this.redis.zrem(KEY, ip);
  }

  async list(): Promise<BlockedEntry[]> {
    await this.prune();
    const raw = await this.redis.zrange(KEY, 0, -1, 'WITHSCORES');
    const entries: BlockedEntry[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      const ip = raw[i];
      const score = raw[i + 1];
      if (ip && score) entries.push({ ip, expiresAt: Number(score) });
    }
    return entries;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

class MemoryBlocklist implements Blocklist {
  /** Bounded: an operator adds these by hand, so the ceiling is generous. */
  private static readonly MAX = 1000;
  private readonly entries = new Map<string, number>();

  async isBlocked(ip: string): Promise<boolean> {
    const expiresAt = this.entries.get(ip);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.entries.delete(ip);
      return false;
    }
    return true;
  }

  async block(ip: string, ttlSeconds: number): Promise<void> {
    if (this.entries.size >= MemoryBlocklist.MAX) {
      // Drop whatever expires soonest rather than refusing the new block: an
      // operator adding one is reacting to something happening now.
      const soonest = [...this.entries.entries()].sort((a, b) => a[1] - b[1])[0];
      if (soonest) this.entries.delete(soonest[0]);
    }
    this.entries.set(ip, Date.now() + ttlSeconds * 1000);
  }

  async unblock(ip: string): Promise<void> {
    this.entries.delete(ip);
  }

  async list(): Promise<BlockedEntry[]> {
    const now = Date.now();
    const entries: BlockedEntry[] = [];
    for (const [ip, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(ip);
      else entries.push({ ip, expiresAt });
    }
    return entries;
  }

  async close(): Promise<void> {
    this.entries.clear();
  }
}

export function createBlocklist(redisUrl: string, password: string): Blocklist {
  if (!redisUrl) return new MemoryBlocklist();

  const redis = new Redis(redisUrl, password ? { password } : {});
  return new RedisBlocklist(redis);
}
