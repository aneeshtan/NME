/**
 * Health dashboard data.
 *
 * Answers "is this being overused" and "is this being attacked". It cannot
 * answer "what happened in meeting X", and that is a property of what is
 * collected rather than of who is allowed to read it — see lib/metrics.ts.
 *
 * Off unless `ADMIN_TOKEN` is set, and 404 rather than 401 when it is not: an
 * endpoint that announces its own existence to an unauthenticated caller is an
 * invitation to guess at it.
 */
import type { FastifyPluginAsync } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { snapshot } from '../lib/metrics.js';
import { countActive } from '../lib/livekit.js';

/**
 * Constant-time comparison. A plain `===` on a secret leaks its length and,
 * over enough requests, its content through timing — cheap to avoid.
 */
function tokenMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/admin/stats',
    {
      // Tighter than the global limit. This endpoint is not on any hot path,
      // and a low ceiling bounds how fast a token can be guessed at.
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        response: {
          // `additionalProperties: true` because the payload is a metrics
          // snapshot whose shape is expected to grow; pinning it here would
          // mean every new counter silently serialising as undefined.
          200: { type: 'object', additionalProperties: true },
          404: {
            type: 'object',
            required: ['error', 'message'],
            properties: {
              error: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const expected = config.admin.token;
      if (!expected) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: 'Not found.' });
      }

      const header = request.headers.authorization ?? '';
      const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';

      if (!supplied || !tokenMatches(supplied, expected)) {
        // Logged without the supplied value: recording guesses would write
        // near-miss secrets into the log file.
        request.log.warn('rejected an unauthenticated admin request');
        return reply.code(404).send({ error: 'NOT_FOUND', message: 'Not found.' });
      }

      const active = await countActive();

      return reply.send({
        active,
        ...snapshot(),
      });
    },
  );
};
