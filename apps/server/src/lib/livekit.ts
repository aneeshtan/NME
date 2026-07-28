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

/** Disconnects a participant. Used to evict a detected token replay. */
export async function evictParticipant(roomId: string, identity: string): Promise<void> {
  await rooms.removeParticipant(roomId, identity);
}
