/**
 * Single-use token registry (replay mitigation).
 *
 * Join tokens are bearer credentials. Their primary defence is a very short TTL
 * (120s by default), but a token captured and replayed inside that window would
 * otherwise be accepted twice. LiveKit fires a `participant_joined` webhook on
 * every successful join; we burn the token's `jti` there, so a second use of the
 * same token is detected and logged.
 *
 * Two backends:
 *  - Redis, when configured — required for correctness across multiple server
 *    replicas, since a replay can land on any of them.
 *  - In-process map, for single-node deployments. Bounded so a flood of
 *    token requests cannot exhaust memory.
 */
import { Redis } from 'ioredis';

export interface NonceStore {
  /** Records an issued token id. */
  register(id: string, ttlSeconds: number): Promise<void>;
  /** Marks a token consumed. Returns false if it was already consumed. */
  consume(id: string): Promise<boolean>;
  close(): Promise<void>;
}

const KEY_PREFIX = 'nme:jti:';

class RedisNonceStore implements NonceStore {
  constructor(private readonly redis: Redis) {}

  async register(id: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(`${KEY_PREFIX}${id}`, '1', 'EX', ttlSeconds);
  }

  async consume(id: string): Promise<boolean> {
    // DEL returns the number of keys removed — atomic test-and-clear, so two
    // concurrent replays cannot both observe the token as unused.
    const removed = await this.redis.del(`${KEY_PREFIX}${id}`);
    return removed === 1;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

class MemoryNonceStore implements NonceStore {
  private readonly entries = new Map<string, number>();
  private readonly sweeper: NodeJS.Timeout;
  private lastSweep = 0;

  /** Hard ceiling; at ~50 bytes/entry this caps the store near 5 MB. */
  private static readonly MAX_ENTRIES = 100_000;
  /** Floor between full scans, so a burst at capacity cannot trigger one per call. */
  private static readonly MIN_SWEEP_INTERVAL_MS = 1_000;

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref();
  }

  private sweep(): void {
    const now = Date.now();
    this.lastSweep = now;
    for (const [id, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(id);
    }
  }

  async register(id: string, ttlSeconds: number): Promise<void> {
    if (this.entries.size >= MemoryNonceStore.MAX_ENTRIES) {
      // A full scan is O(n). Calling it on every insert while at capacity turns
      // token issuance into an O(n) operation and pins the CPU, so it is rate
      // limited; between sweeps the O(1) eviction below keeps the bound.
      const now = Date.now();
      if (now - this.lastSweep >= MemoryNonceStore.MIN_SWEEP_INTERVAL_MS) {
        this.sweep();
      }
      // Map preserves insertion order, so the first key is the oldest entry —
      // and with a 120s TTL it is the closest to expiry anyway.
      while (this.entries.size >= MemoryNonceStore.MAX_ENTRIES) {
        const oldest = this.entries.keys().next();
        if (oldest.done) break;
        this.entries.delete(oldest.value);
      }
    }
    this.entries.set(id, Date.now() + ttlSeconds * 1000);
  }

  async consume(id: string): Promise<boolean> {
    const expiresAt = this.entries.get(id);
    if (expiresAt === undefined) return false;
    this.entries.delete(id);
    return expiresAt > Date.now();
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    this.entries.clear();
  }
}

export function createNonceStore(url: string, password: string): NonceStore {
  if (!url) return new MemoryNonceStore();

  const redis = new Redis(url, {
    ...(password ? { password } : {}),
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    // Fail fast rather than hanging a request behind a dead Redis.
    connectTimeout: 3_000,
  });
  return new RedisNonceStore(redis);
}

export { MemoryNonceStore, RedisNonceStore };
