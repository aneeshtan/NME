/**
 * LiveKit control plane.
 *
 * The only module holding the API secret. It does three things: create rooms
 * under a fixed policy, mint narrowly-scoped join tokens, and evict replays.
 */
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { config } from '../config.js';
import { createParticipantId } from './ids.js';

const rooms = new RoomServiceClient(
  config.livekit.host,
  config.livekit.apiKey,
  config.livekit.apiSecret,
);

/**
 * Creates the room if absent. Idempotent — LiveKit returns the existing room
 * rather than erroring, so a race between two simultaneous joiners is harmless.
 */
export async function ensureRoom(roomId: string): Promise<void> {
  await rooms.createRoom({
    name: roomId,
    emptyTimeout: config.room.emptyTimeout,
    departureTimeout: config.room.departureTimeout,
    maxParticipants: config.room.maxParticipants,
  });
}

export interface IssuedToken {
  token: string;
  /** Doubles as the replay nonce — see `issueJoinToken`. */
  identity: string;
  expiresAt: number;
}

/**
 * Mints a join token.
 *
 * Grants are deliberately minimal. The token authorises exactly one room and
 * carries no administrative capability:
 *
 *  - `roomJoin` + `room`        : usable in this room only.
 *  - `canPublish`/`canSubscribe`: ordinary participation.
 *  - `canPublishData`           : required for LiveKit's E2EE key ratchet.
 *  - `roomCreate`/`roomAdmin`/`roomList` are absent, so a leaked token cannot
 *    enumerate meetings, evict participants, or mutate room settings.
 *  - `canUpdateOwnMetadata` is absent, so a participant cannot rewrite the
 *    server-assigned display name after joining and impersonate someone.
 *  - `recorder` is absent — no participant can request a server-side egress.
 *
 * Replay handling: the SDK offers no custom `jti`, so the randomly generated
 * `identity` serves as the nonce. It is unique per issuance and appears in the
 * `participant_joined` webhook, which lets us detect a second use of the same
 * token. LiveKit additionally treats identity as a unique key, so a replay
 * would collide with the legitimate session rather than open a silent parallel
 * one.
 */
export async function issueJoinToken(roomId: string, displayName: string): Promise<IssuedToken> {
  const identity = createParticipantId();
  const ttl = config.room.tokenTtlSeconds;

  const accessToken = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity,
    name: displayName,
    ttl,
  });

  accessToken.addGrant({
    roomJoin: true,
    room: roomId,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: false,
    hidden: false,
    recorder: false,
  });

  return {
    token: await accessToken.toJwt(),
    identity,
    expiresAt: Date.now() + ttl * 1000,
  };
}

/** Participant count without exposing identities. Used for the capacity check. */
export async function countParticipants(roomId: string): Promise<number> {
  try {
    const participants = await rooms.listParticipants(roomId);
    return participants.length;
  } catch {
    // Room does not exist yet; an empty room is the correct answer.
    return 0;
  }
}

/**
 * Live totals for the health dashboard.
 *
 * Asked of LiveKit at request time rather than tracked as server state: the SFU
 * already knows, and mirroring it here would mean a second source of truth that
 * drifts whenever a room is reaped without the control plane noticing.
 *
 * Deliberately returns counts only. Room names are hashes of encryption keys —
 * see lib/metrics.ts on why they must not travel any further than this file.
 */
export async function countActive(): Promise<{ rooms: number; participants: number }> {
  try {
    const active = await rooms.listRooms();
    return {
      rooms: active.length,
      participants: active.reduce((sum, room) => sum + room.numParticipants, 0),
    };
  } catch {
    return { rooms: 0, participants: 0 };
  }
}

/** Disconnects a participant. Used to evict a detected token replay. */
export async function evictParticipant(roomId: string, identity: string): Promise<void> {
  await rooms.removeParticipant(roomId, identity);
}

/**
 * Presence cache.
 *
 * Admission is authorised by "are you currently in this room", which means
 * every participant polling for knocks would otherwise trigger a LiveKit call
 * each time — N participants times every poll interval. Caching the roster for
 * a couple of seconds collapses that to roughly one call per room per interval,
 * regardless of how many people are looking.
 */
const presenceCache = new Map<string, { identities: Set<string>; expiresAt: number }>();
const PRESENCE_TTL_MS = 2_000;
/** Bounded so a flood of room ids cannot grow this without limit. */
const PRESENCE_MAX_ROOMS = 5_000;

/**
 * Whether an identity is currently connected to the room.
 *
 * This is what replaces a password for admission rights: identities are 96 bits
 * of randomness, known only to their owner and the server, and they stop being
 * valid the moment that person disconnects. Someone who leaves the meeting
 * therefore loses the ability to admit anyone, without any explicit revocation.
 */
export async function isParticipantPresent(roomId: string, identity: string): Promise<boolean> {
  const now = Date.now();
  const cached = presenceCache.get(roomId);

  if (cached && cached.expiresAt > now) return cached.identities.has(identity);

  try {
    const participants = await rooms.listParticipants(roomId);
    const identities = new Set(participants.map((participant) => participant.identity));

    if (presenceCache.size >= PRESENCE_MAX_ROOMS) {
      const oldest = presenceCache.keys().next();
      if (!oldest.done) presenceCache.delete(oldest.value);
    }
    presenceCache.set(roomId, { identities, expiresAt: now + PRESENCE_TTL_MS });

    return identities.has(identity);
  } catch {
    // Room gone or SFU unreachable: fail closed rather than admitting on a
    // lookup we could not perform.
    return false;
  }
}
