/**
 * Lobby: admission control for rooms that ask for it.
 *
 * This is the one control that closes the "the link is the credential" gap. A
 * forwarded invitation no longer means silent entry — someone already inside
 * has to admit each arrival, and until they do the joiner never receives a
 * token, so they never reach the SFU at all. That enforcement has to live on
 * the server: a client-side gate would be pointless, because by the time a
 * client could refuse anyone, that person would already hold a valid token.
 *
 * State is deliberately ephemeral. A room's lobby, its host secret, and every
 * pending knock expire on their own, so nothing here becomes a durable record
 * of who met whom.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Redis } from 'ioredis';

export interface Knock {
  id: string;
  displayName: string;
  status: 'pending' | 'admitted' | 'denied';
  /** Set once admitted; collected exactly once by the waiting client. */
  token?: string;
  livekitUrl?: string;
  identity?: string;
  createdAt: number;
}

export interface LobbyStore {
  enable(roomId: string, hostKeyHash: string, ttl: number): Promise<void>;
  isEnabled(roomId: string): Promise<boolean>;
  verifyHost(roomId: string, hostKey: string): Promise<boolean>;
  knock(roomId: string, knock: Knock, ttl: number): Promise<void>;
  listKnocks(roomId: string): Promise<Knock[]>;
  getKnock(roomId: string, knockId: string): Promise<Knock | null>;
  resolveKnock(roomId: string, knock: Knock, ttl: number): Promise<void>;
  close(): Promise<void>;
}

/** Rooms and knocks are short-lived by design. */
export const LOBBY_TTL_SECONDS = 12 * 60 * 60;
export const KNOCK_TTL_SECONDS = 5 * 60;

/** Host secrets are compared as fixed-length hashes, never as raw strings. */
export function hashHostKey(hostKey: string): string {
  return createHash('sha256').update(hostKey).digest('hex');
}

export function createHostKey(): string {
  return randomBytes(32).toString('base64url');
}

export function createKnockId(): string {
  return randomBytes(18).toString('base64url');
}

/**
 * Constant-time comparison.
 *
 * A plain `===` on the host secret would leak its prefix through response
 * timing, letting an attacker recover it byte by byte. Both sides are hashed
 * first so the buffers are always the same length, which `timingSafeEqual`
 * requires and which also stops length itself being a signal.
 */
export function hostKeyMatches(expectedHash: string, providedKey: string): boolean {
  const provided = Buffer.from(hashHostKey(providedKey), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

const KEY = {
  lobby: (roomId: string) => `nme:lobby:${roomId}`,
  knock: (roomId: string, knockId: string) => `nme:knock:${roomId}:${knockId}`,
  knockSet: (roomId: string) => `nme:knocks:${roomId}`,
};

class RedisLobbyStore implements LobbyStore {
  constructor(private readonly redis: Redis) {}

  async enable(roomId: string, hostKeyHash: string, ttl: number): Promise<void> {
    await this.redis.set(KEY.lobby(roomId), hostKeyHash, 'EX', ttl);
  }

  async isEnabled(roomId: string): Promise<boolean> {
    return (await this.redis.exists(KEY.lobby(roomId))) === 1;
  }

  async verifyHost(roomId: string, hostKey: string): Promise<boolean> {
    const stored = await this.redis.get(KEY.lobby(roomId));
    return stored ? hostKeyMatches(stored, hostKey) : false;
  }

  async knock(roomId: string, knock: Knock, ttl: number): Promise<void> {
    await this.redis
      .multi()
      .set(KEY.knock(roomId, knock.id), JSON.stringify(knock), 'EX', ttl)
      .sadd(KEY.knockSet(roomId), knock.id)
      .expire(KEY.knockSet(roomId), ttl)
      .exec();
  }

  async listKnocks(roomId: string): Promise<Knock[]> {
    const ids = await this.redis.smembers(KEY.knockSet(roomId));
    if (ids.length === 0) return [];

    const raw = await this.redis.mget(ids.map((id) => KEY.knock(roomId, id)));
    const knocks: Knock[] = [];

    for (const [index, value] of raw.entries()) {
      if (!value) {
        // Expired: drop the dangling index entry so the set does not grow.
        const id = ids[index];
        if (id) await this.redis.srem(KEY.knockSet(roomId), id);
        continue;
      }
      knocks.push(JSON.parse(value) as Knock);
    }
    return knocks;
  }

  async getKnock(roomId: string, knockId: string): Promise<Knock | null> {
    const raw = await this.redis.get(KEY.knock(roomId, knockId));
    return raw ? (JSON.parse(raw) as Knock) : null;
  }

  async resolveKnock(roomId: string, knock: Knock, ttl: number): Promise<void> {
    await this.redis.set(KEY.knock(roomId, knock.id), JSON.stringify(knock), 'EX', ttl);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

/**
 * Single-node fallback. Bounded, because an unauthenticated endpoint creates
 * these and unbounded growth would be a denial-of-service vector.
 */
class MemoryLobbyStore implements LobbyStore {
  private readonly lobbies = new Map<string, { hash: string; expiresAt: number }>();
  private readonly knocks = new Map<string, { knock: Knock; expiresAt: number }>();
  private readonly sweeper: NodeJS.Timeout;

  private static readonly MAX_KNOCKS = 10_000;

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.lobbies) if (entry.expiresAt <= now) this.lobbies.delete(key);
    for (const [key, entry] of this.knocks) if (entry.expiresAt <= now) this.knocks.delete(key);
  }

  async enable(roomId: string, hostKeyHash: string, ttl: number): Promise<void> {
    this.lobbies.set(roomId, { hash: hostKeyHash, expiresAt: Date.now() + ttl * 1000 });
  }

  async isEnabled(roomId: string): Promise<boolean> {
    const entry = this.lobbies.get(roomId);
    return Boolean(entry && entry.expiresAt > Date.now());
  }

  async verifyHost(roomId: string, hostKey: string): Promise<boolean> {
    const entry = this.lobbies.get(roomId);
    if (!entry || entry.expiresAt <= Date.now()) return false;
    return hostKeyMatches(entry.hash, hostKey);
  }

  async knock(roomId: string, knock: Knock, ttl: number): Promise<void> {
    if (this.knocks.size >= MemoryLobbyStore.MAX_KNOCKS) this.sweep();
    if (this.knocks.size >= MemoryLobbyStore.MAX_KNOCKS) {
      const oldest = this.knocks.keys().next();
      if (!oldest.done) this.knocks.delete(oldest.value);
    }
    this.knocks.set(`${roomId}:${knock.id}`, {
      knock,
      expiresAt: Date.now() + ttl * 1000,
    });
  }

  async listKnocks(roomId: string): Promise<Knock[]> {
    const now = Date.now();
    const prefix = `${roomId}:`;
    const out: Knock[] = [];
    for (const [key, entry] of this.knocks) {
      if (key.startsWith(prefix) && entry.expiresAt > now) out.push(entry.knock);
    }
    return out;
  }

  async getKnock(roomId: string, knockId: string): Promise<Knock | null> {
    const entry = this.knocks.get(`${roomId}:${knockId}`);
    return entry && entry.expiresAt > Date.now() ? entry.knock : null;
  }

  async resolveKnock(roomId: string, knock: Knock, ttl: number): Promise<void> {
    this.knocks.set(`${roomId}:${knock.id}`, {
      knock,
      expiresAt: Date.now() + ttl * 1000,
    });
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    this.lobbies.clear();
    this.knocks.clear();
  }
}

export function createLobbyStore(redis: Redis | null): LobbyStore {
  return redis ? new RedisLobbyStore(redis) : new MemoryLobbyStore();
}

export { MemoryLobbyStore };
