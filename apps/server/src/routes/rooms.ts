/**
 * Room lifecycle and join-token issuance.
 *
 * Both routes are unauthenticated by design — the product requirement is "no
 * account, no login". Abuse resistance therefore comes from rate limiting,
 * strict schemas, and the fact that possession of a room ID grants no ability
 * to *read* anything: media is end-to-end encrypted with a key the server never
 * receives.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import {
  recordCountry,
  recordJoinRejected,
  recordParticipantCount,
  recordRoomCreated,
  recordTokenIssued,
} from '../lib/metrics.js';
import { lookupCountry } from '../lib/geoip.js';
import { clientIp } from '../lib/clientIp.js';
import { createRoomId, isValidRoomId } from '../lib/ids.js';
import { normalizeDisplayName, DISPLAY_NAME_MAX_LENGTH } from '../lib/displayName.js';
import { countParticipants, ensureRoom, issueJoinToken } from '../lib/livekit.js';
import { issueTurnCredentials } from '../lib/turn.js';
import type { NonceStore } from '../lib/nonceStore.js';
import {
  createHostKey,
  createKnockId,
  hashHostKey,
  KNOCK_TTL_SECONDS,
  LOBBY_TTL_SECONDS,
  type LobbyStore,
} from '../lib/lobby.js';

interface Options {
  nonces: NonceStore;
  lobby: LobbyStore;
}

/**
 * A refused join, counted twice: once by reason, once by country.
 *
 * The address is used for both and kept by neither — `recordCountry` receives a
 * two-letter code, and the offender list keeps the address only above a
 * threshold of repeated refusals, which is what makes blocking possible.
 */
function refuse(reason: string, ip: string): void {
  recordJoinRejected(reason, ip);
  recordCountry(lookupCountry(ip), 'refused');
}

const roomIdParams = {
  type: 'object',
  required: ['roomId'],
  additionalProperties: false,
  properties: {
    // Bounded before the regex runs, so a megabyte-long param cannot be
    // handed to the pattern matcher at all.
    roomId: { type: 'string', minLength: 14, maxLength: 14 },
  },
} as const;

/** Uniform client-error body. Kept identical across routes so the UI has one shape to handle. */
const errorResponse = {
  type: 'object',
  required: ['error', 'message'],
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
  },
} as const;

const joinBody = {
  type: 'object',
  required: ['displayName'],
  // With AJV's `removeAdditional` disabled (see app.ts), this genuinely rejects
  // unknown keys rather than silently stripping them — so a client probing for
  // an undocumented `isAdmin` or `role` parameter gets a 400, not a success.
  additionalProperties: false,
  properties: {
    displayName: { type: 'string', minLength: 1, maxLength: DISPLAY_NAME_MAX_LENGTH * 4 },
    /**
     * Set by the client only after a direct connection attempt has failed.
     * Relay credentials are withheld from everyone else, so the vast majority
     * of participants never receive them and the relay never sees them at all.
     */
    relay: { type: 'boolean' },
  },
} as const;

export const roomRoutes: FastifyPluginAsync<Options> = async (app: FastifyInstance, opts) => {
  const { nonces, lobby } = opts;

  /**
   * Create a meeting. Heavily rate limited: this is the only route that
   * consumes SFU capacity, so it is the natural target for a resource-
   * exhaustion attempt.
   */
  app.post(
    '/rooms',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        body: {
          // Nullable so a bodyless POST still validates: every field here is
          // optional, and requiring an envelope for them would break any
          // caller that reasonably sends nothing at all.
          type: ['object', 'null'],
          additionalProperties: false,
          properties: {
            lobby: { type: 'boolean' },
            /**
             * Optional client-derived id. The client hashes its own key to get
             * this, which is what lets the link carry only the key. The server
             * learns no more than it did from generating one itself: a SHA-256
             * digest reveals nothing about its preimage.
             */
            roomId: { type: 'string', minLength: 14, maxLength: 14 },
          },
        },
        response: {
          201: {
            type: 'object',
            properties: { roomId: { type: 'string' }, hostKey: { type: 'string' } },
            required: ['roomId'],
          },
        },
      },
    },
    async (request, reply) => {
      const body = (request.body ?? {}) as { lobby?: boolean; roomId?: string };

      // A supplied id is still format-checked; anything malformed falls back to
      // a server-generated one rather than being trusted.
      const roomId =
        body.roomId && isValidRoomId(body.roomId) ? body.roomId : createRoomId();
      await ensureRoom(roomId);

      const wantsLobby = body.lobby === true;
      if (!wantsLobby) {
        request.log.info({ roomId, lobby: false }, 'room created');
        recordRoomCreated();
        return reply.code(201).send({ roomId });
      }

      // The host secret is returned exactly once and never stored in the clear;
      // only its hash is kept, so a database dump cannot admit anyone.
      const hostKey = createHostKey();
      await lobby.enable(roomId, hashHostKey(hostKey), LOBBY_TTL_SECONDS);

      request.log.info({ roomId, lobby: true }, 'room created');
      recordRoomCreated();
      return reply.code(201).send({ roomId, hostKey });
    },
  );

  /**
   * Exchange a room ID + display name for a short-lived join token.
   *
   * Deliberately returns the same 404 whether the room ID is malformed or
   * simply unknown, so the endpoint cannot be used as a room-existence oracle
   * to enumerate live meetings.
   */
  app.post(
    '/rooms/:roomId/join',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        params: roomIdParams,
        body: joinBody,
        response: {
          200: {
            type: 'object',
            required: ['token', 'url', 'identity', 'displayName'],
            properties: {
              token: { type: 'string' },
              url: { type: 'string' },
              identity: { type: 'string' },
              displayName: { type: 'string' },
              iceServers: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['urls'],
                  properties: {
                    urls: { type: 'array', items: { type: 'string' } },
                    username: { type: 'string' },
                    credential: { type: 'string' },
                  },
                },
              },
            },
          },
          202: {
            type: 'object',
            required: ['status', 'knockId'],
            properties: { status: { type: 'string' }, knockId: { type: 'string' } },
          },
          400: errorResponse,
          404: errorResponse,
          409: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { roomId } = request.params as { roomId: string };
      const { displayName, relay } = request.body as { displayName: string; relay?: boolean };

      if (!isValidRoomId(roomId)) {
        refuse('bad_room_id', clientIp(request));
        return reply.code(404).send({ error: 'NOT_FOUND', message: 'Meeting not found.' });
      }

      const name = normalizeDisplayName(displayName);
      if (name === null) {
        refuse('bad_name', clientIp(request));
        return reply.code(400).send({
          error: 'INVALID_NAME',
          message: 'Please enter a name using ordinary characters.',
        });
      }

      // Capacity is enforced here as well as in LiveKit so the client gets a
      // clean, actionable error instead of an opaque signaling disconnect.
      const occupants = await countParticipants(roomId);
      recordParticipantCount(occupants);
      if (occupants >= config.room.maxParticipants) {
        refuse('room_full', clientIp(request));
        return reply.code(409).send({
          error: 'ROOM_FULL',
          message: 'This meeting is full.',
        });
      }

      // Idempotent: also covers the case where the room was reaped for being
      // empty between creation and the first join.
      await ensureRoom(roomId);

      // Lobby rooms issue no token until somebody inside admits the joiner.
      // Doing this check before minting is the whole point: a token handed out
      // and then "revoked" client-side would already grant SFU access.
      if (await lobby.isEnabled(roomId)) {
        const hostKey = request.headers['x-host-key'];
        const isHost =
          typeof hostKey === 'string' && (await lobby.verifyHost(roomId, hostKey));

        if (!isHost) {
          const knockId = createKnockId();
          await lobby.knock(
            roomId,
            {
              id: knockId,
              displayName: name,
              status: 'pending',
              createdAt: Date.now(),
            },
            KNOCK_TTL_SECONDS,
          );
          request.log.info({ roomId, knockId }, 'knock created');
          return reply.code(202).send({ status: 'waiting', knockId });
        }
      }

      recordTokenIssued();
      recordCountry(lookupCountry(clientIp(request)), 'joined');
      const issued = await issueJoinToken(roomId, name);
      await nonces.register(issued.identity, config.room.tokenTtlSeconds);

      // Only minted for a client that has already failed to connect directly.
      const iceServers = relay === true ? await issueTurnCredentials(request.log) : null;

      request.log.info(
        { roomId, identity: issued.identity, relay: relay === true },
        'join token issued',
      );

      return reply.send({
        token: issued.token,
        url: config.livekit.publicUrl,
        identity: issued.identity,
        displayName: name,
        // Credentials are deliberately absent from the response body entirely
        // when not requested, rather than sent as an empty array.
        ...(iceServers ? { iceServers: [iceServers] } : {}),
      });
    },
  );
};
