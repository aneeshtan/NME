/**
 * Health and runtime client configuration.
 *
 * Serving config at runtime rather than baking it into the bundle means one
 * built image works for every self-hosted deployment — no rebuild to change a
 * hostname. Only non-secret values appear here.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { config } from '../config.js';

export const metaRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get('/health', { config: { rateLimit: false }, logLevel: 'warn' }, async () => ({
    status: 'ok',
  }));

  app.get(
    '/config',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        response: {
          200: {
            type: 'object',
            required: ['livekitUrl', 'maxParticipants', 'videoCodec'],
            properties: {
              livekitUrl: { type: 'string' },
              maxParticipants: { type: 'integer' },
              videoCodec: { type: 'string' },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      // Cacheable: this changes only on redeploy, and a stale value for a
      // minute is harmless while removing a request from the join critical path.
      reply.header('Cache-Control', 'public, max-age=60');
      return {
        livekitUrl: config.livekit.publicUrl,
        maxParticipants: config.room.maxParticipants,
        videoCodec: config.media.videoCodec,
      };
    },
  );
};
