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
import { listOffenders, snapshot } from '../lib/metrics.js';
import { countActive } from '../lib/livekit.js';
import { sfuSnapshot } from '../lib/sfu.js';
import { systemSnapshot } from '../lib/system.js';
import { geoipStatus } from '../lib/geoip.js';
import type { Blocklist } from '../lib/blocklist.js';

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

interface Options {
  blocklist: Blocklist;
}

/** Rejects anything that is not a bare IPv4 or IPv6 literal. */
const IP_PATTERN = /^[0-9a-fA-F.:]{3,45}$/;

export const adminRoutes: FastifyPluginAsync<Options> = async (app, { blocklist }) => {
  /**
   * Shared gate. Returning 404 rather than 401 in every case means an
   * unauthenticated caller cannot tell these routes exist at all.
   */
  const authorise = (request: { headers: Record<string, unknown>; log: { warn: (msg: string) => void } }): boolean => {
    const expected = config.admin.token;
    if (!expected) return false;

    const header = typeof request.headers.authorization === 'string' ? request.headers.authorization : '';
    const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!supplied || !tokenMatches(supplied, expected)) {
      request.log.warn('rejected an unauthenticated admin request');
      return false;
    }
    return true;
  };

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
      if (!authorise(request)) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: 'Not found.' });
      }

      /**
       * Every source in parallel. Three of the four reach outside this process
       * — LiveKit, Redis, and the cgroup files — and serialising them would put
       * the slowest one's latency on top of the others for no reason.
       *
       * The SFU media figures are the exception: they come from a scrape loop
       * running on its own timer, because a rate needs two readings and cannot
       * be produced by a single request. See lib/sfu.ts.
       */
      const [active, blocked, store, system] = await Promise.all([
        countActive(),
        blocklist.list(),
        blocklist.health(),
        systemSnapshot(),
      ]);

      return reply.send({
        active,
        blocked,
        offenders: listOffenders(),
        sfu: sfuSnapshot(),
        system,
        store,
        geoip: geoipStatus(),
        ...snapshot(),
      });
    },
  );

  /**
   * Block or unblock a source.
   *
   * A TTL rather than a permanent entry: addresses are reassigned, and a list
   * that only grows is the durable record this design avoids everywhere else.
   */
  app.post(
    '/admin/block',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['ip'],
          properties: {
            ip: { type: 'string', maxLength: 45 },
            hours: { type: 'integer', minimum: 1, maximum: 720 },
            unblock: { type: 'boolean' },
          },
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          400: { type: 'object', additionalProperties: true },
          404: { type: 'object', additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      if (!authorise(request)) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: 'Not found.' });
      }

      const { ip, hours = 24, unblock = false } = request.body as {
        ip: string;
        hours?: number;
        unblock?: boolean;
      };

      // Validated rather than trusted: this string is stored and compared
      // against request.ip, and anything else has no business in either.
      if (!IP_PATTERN.test(ip)) {
        return reply.code(400).send({ error: 'INVALID_IP', message: 'Not an address.' });
      }

      if (unblock) {
        await blocklist.unblock(ip);
        request.log.warn({ target: ip }, 'admin unblocked a source');
      } else {
        await blocklist.block(ip, hours * 3600);
        request.log.warn({ target: ip, hours }, 'admin blocked a source');
      }

      return reply.send({ ok: true, blocked: await blocklist.list() });
    },
  );
};
