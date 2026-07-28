/**
 * LiveKit webhook receiver.
 *
 * LiveKit signs each delivery with a JWT in the Authorization header whose body
 * hash covers the payload. `WebhookReceiver.receive` verifies both the
 * signature and the hash, so an attacker cannot forge events even though the
 * endpoint is publicly reachable. The raw body is required for that hash check,
 * which is why this route opts out of JSON parsing.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { WebhookReceiver } from 'livekit-server-sdk';
import { config } from '../config.js';
import { evictParticipant } from '../lib/livekit.js';
import type { NonceStore } from '../lib/nonceStore.js';

interface Options {
  nonces: NonceStore;
}

export const webhookRoutes: FastifyPluginAsync<Options> = async (
  app: FastifyInstance,
  opts,
) => {
  const { nonces } = opts;
  const receiver = new WebhookReceiver(config.livekit.apiKey, config.livekit.apiSecret);

  // LiveKit posts `application/webhook+json`; take the body verbatim.
  app.addContentTypeParser(
    ['application/webhook+json', 'application/json'],
    { parseAs: 'string' },
    (_request, payload, done) => done(null, payload),
  );

  app.post(
    '/webhooks/livekit',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request, reply) => {
      let event;
      try {
        event = await receiver.receive(
          request.body as string,
          request.headers.authorization,
          false,
          // Tolerate modest clock skew between containers without opening a
          // meaningful replay window.
          30,
        );
      } catch (error) {
        request.log.warn({ err: error }, 'rejected unsigned or invalid webhook');
        // 401 rather than 400: the payload may be well-formed but unauthentic.
        return reply.code(401).send({ error: 'UNAUTHORIZED' });
      }

      if (event.event === 'participant_joined' && event.participant && event.room) {
        const identity = event.participant.identity;
        const roomId = event.room.name;
        const fresh = await nonces.consume(identity);

        if (!fresh) {
          // The nonce was already burned (or expired): this token has been used
          // before. Evict rather than trust — the legitimate holder can rejoin
          // with a freshly issued token in under a second.
          request.log.warn({ roomId, identity }, 'token replay detected; evicting');
          await evictParticipant(roomId, identity).catch((error: unknown) => {
            request.log.error({ err: error, roomId, identity }, 'eviction failed');
          });
        }
      }

      return reply.code(200).send({ ok: true });
    },
  );
};
