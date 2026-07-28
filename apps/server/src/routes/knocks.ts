/**
 * Lobby endpoints: the host lists and resolves knocks; the waiting joiner polls
 * for a verdict.
 *
 * Polling rather than a push channel because the alternative would mean giving
 * a not-yet-admitted client a connection into the room, which is precisely what
 * the lobby exists to withhold. A knock is resolved in seconds, so a short poll
 * costs little.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';
import { isValidRoomId } from '../lib/ids.js';
import { issueJoinToken, isParticipantPresent } from '../lib/livekit.js';
import { issueTurnCredentials } from '../lib/turn.js';
import { KNOCK_TTL_SECONDS, type LobbyStore } from '../lib/lobby.js';
import type { NonceStore } from '../lib/nonceStore.js';

interface Options {
  nonces: NonceStore;
  lobby: LobbyStore;
}

const roomIdParams = {
  type: 'object',
  required: ['roomId'],
  additionalProperties: false,
  properties: { roomId: { type: 'string', minLength: 14, maxLength: 14 } },
} as const;

export const knockRoutes: FastifyPluginAsync<Options> = async (
  app: FastifyInstance,
  opts,
) => {
  const { nonces, lobby } = opts;

  /**
   * May this request admit people?
   *
   * Anyone already in the meeting can, which is what people expect and what
   * avoids the failure mode of a single host: if only the creator could admit,
   * a meeting where they never arrive — or arrive from another browser — is one
   * nobody can ever be let into.
   *
   * Two ways to qualify:
   *  - the host secret, which also lets the creator enter their own lobby
   *    before anyone else exists to admit them;
   *  - being currently connected, per the SFU. This needs no new credential and
   *    revokes itself on disconnect.
   *
   * Both travel as headers so neither reaches a URL, an access log, or a
   * Referer.
   */
  async function canAdmit(roomId: string, headers: Record<string, unknown>): Promise<boolean> {
    const hostKey = headers['x-host-key'];
    if (typeof hostKey === 'string' && (await lobby.verifyHost(roomId, hostKey))) return true;

    const identity = headers['x-participant-identity'];
    return typeof identity === 'string' && (await isParticipantPresent(roomId, identity));
  }

  /** Host: who is waiting. */
  app.get(
    '/rooms/:roomId/knocks',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: { params: roomIdParams },
    },
    async (request, reply) => {
      const { roomId } = request.params as { roomId: string };
      if (!isValidRoomId(roomId)) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: 'Meeting not found.' });
      }

      if (!(await canAdmit(roomId, request.headers))) {
        // 403 regardless of whether the room has a lobby at all, so this cannot
        // be used to discover which rooms are gated.
        return reply.code(403).send({ error: 'FORBIDDEN', message: 'Not in this meeting.' });
      }

      const knocks = await lobby.listKnocks(roomId);
      return reply.send({
        knocks: knocks
          .filter((knock) => knock.status === 'pending')
          .map((knock) => ({
            id: knock.id,
            displayName: knock.displayName,
            createdAt: knock.createdAt,
          })),
      });
    },
  );

  /** Host: admit or deny. */
  app.post(
    '/rooms/:roomId/knocks/:knockId',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        params: {
          type: 'object',
          required: ['roomId', 'knockId'],
          additionalProperties: false,
          properties: {
            roomId: { type: 'string', minLength: 14, maxLength: 14 },
            knockId: { type: 'string', minLength: 8, maxLength: 64 },
          },
        },
        body: {
          type: 'object',
          required: ['admit'],
          additionalProperties: false,
          properties: { admit: { type: 'boolean' } },
        },
      },
    },
    async (request, reply) => {
      const { roomId, knockId } = request.params as { roomId: string; knockId: string };
      const { admit } = request.body as { admit: boolean };

      if (!isValidRoomId(roomId)) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: 'Meeting not found.' });
      }
      if (!(await canAdmit(roomId, request.headers))) {
        return reply.code(403).send({ error: 'FORBIDDEN', message: 'Not in this meeting.' });
      }

      const knock = await lobby.getKnock(roomId, knockId);
      if (!knock || knock.status !== 'pending') {
        return reply.code(404).send({ error: 'NOT_FOUND', message: 'Request expired.' });
      }

      if (!admit) {
        await lobby.resolveKnock(roomId, { ...knock, status: 'denied' }, KNOCK_TTL_SECONDS);
        request.log.info({ roomId, knockId }, 'knock denied');
        return reply.send({ status: 'denied' });
      }

      // The token is minted only now, at the moment of approval, so its short
      // lifetime is measured from admission rather than from the knock.
      const issued = await issueJoinToken(roomId, knock.displayName);
      await nonces.register(issued.identity, config.room.tokenTtlSeconds);

      await lobby.resolveKnock(
        roomId,
        {
          ...knock,
          status: 'admitted',
          token: issued.token,
          livekitUrl: config.livekit.publicUrl,
          identity: issued.identity,
        },
        KNOCK_TTL_SECONDS,
      );

      request.log.info({ roomId, knockId }, 'knock admitted');
      return reply.send({ status: 'admitted' });
    },
  );

  /**
   * Joiner: poll for the verdict.
   *
   * Knowing a knock id proves nothing about identity, but the id is 144 bits of
   * randomness and only its holder ever saw it, so it is sufficient to collect
   * the token that was minted for that specific request.
   */
  app.post(
    '/rooms/:roomId/knocks/:knockId/claim',
    {
      config: { rateLimit: { max: 200, timeWindow: '1 minute' } },
      schema: {
        params: {
          type: 'object',
          required: ['roomId', 'knockId'],
          additionalProperties: false,
          properties: {
            roomId: { type: 'string', minLength: 14, maxLength: 14 },
            knockId: { type: 'string', minLength: 8, maxLength: 64 },
          },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { relay: { type: 'boolean' } },
        },
      },
    },
    async (request, reply) => {
      const { roomId, knockId } = request.params as { roomId: string; knockId: string };
      const { relay } = (request.body ?? {}) as { relay?: boolean };

      if (!isValidRoomId(roomId)) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: 'Meeting not found.' });
      }

      const knock = await lobby.getKnock(roomId, knockId);
      if (!knock) {
        return reply.code(404).send({ error: 'EXPIRED', message: 'Request expired.' });
      }
      if (knock.status === 'pending') {
        return reply.send({ status: 'waiting' });
      }
      if (knock.status === 'denied' || !knock.token) {
        return reply.send({ status: 'denied' });
      }

      const iceServers = relay === true ? await issueTurnCredentials(request.log) : null;

      return reply.send({
        status: 'admitted',
        token: knock.token,
        url: knock.livekitUrl ?? config.livekit.publicUrl,
        identity: knock.identity,
        displayName: knock.displayName,
        ...(iceServers ? { iceServers: [iceServers] } : {}),
      });
    },
  );
};
