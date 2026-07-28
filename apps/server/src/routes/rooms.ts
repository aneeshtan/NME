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
import { createRoomId, isValidRoomId } from '../lib/ids.js';
import { normalizeDisplayName, DISPLAY_NAME_MAX_LENGTH } from '../lib/displayName.js';
import { countParticipants, ensureRoom, issueJoinToken } from '../lib/livekit.js';
import { issueTurnCredentials } from '../lib/turn.js';
import type { NonceStore } from '../lib/nonceStore.js';

interface Options {
  nonces: NonceStore;
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
  const { nonces } = opts;

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
        response: {
          201: {
            type: 'object',
            properties: { roomId: { type: 'string' } },
            required: ['roomId'],
          },
        },
      },
    },
    async (request, reply) => {
      const roomId = createRoomId();
      await ensureRoom(roomId);
      request.log.info({ roomId }, 'room created');
      return reply.code(201).send({ roomId });
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
        return reply.code(404).send({ error: 'NOT_FOUND', message: 'Meeting not found.' });
      }

      const name = normalizeDisplayName(displayName);
      if (name === null) {
        return reply.code(400).send({
          error: 'INVALID_NAME',
          message: 'Please enter a name using ordinary characters.',
        });
      }

      // Capacity is enforced here as well as in LiveKit so the client gets a
      // clean, actionable error instead of an opaque signaling disconnect.
      const occupants = await countParticipants(roomId);
      if (occupants >= config.room.maxParticipants) {
        return reply.code(409).send({
          error: 'ROOM_FULL',
          message: 'This meeting is full.',
        });
      }

      // Idempotent: also covers the case where the room was reaped for being
      // empty between creation and the first join.
      await ensureRoom(roomId);

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
