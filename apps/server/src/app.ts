/**
 * Fastify application assembly and the security middleware stack.
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { Redis } from 'ioredis';
import { config } from './config.js';
import { metaRoutes } from './routes/meta.js';
import { roomRoutes } from './routes/rooms.js';
import { webhookRoutes } from './routes/webhooks.js';
import type { NonceStore } from './lib/nonceStore.js';

/** Requests that mutate state and must originate from a known browser origin. */
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Dedicated connection for the rate limiter. `enableOfflineQueue: false` makes
 * a Redis outage fail the limiter open immediately instead of queueing requests
 * until the event loop drowns — availability is the right trade here, since the
 * per-route ceilings still bound damage.
 */
function createLimiterRedis(): Redis {
  return new Redis(config.redis.url, {
    ...(config.redis.password ? { password: config.redis.password } : {}),
    connectTimeout: 3_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
}

export async function buildApp(nonces: NonceStore): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Never log tokens, cookies, or credentials — logs outlive the secrets
      // they contain and are frequently shipped to third-party aggregators.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'req.body.displayName',
          // Relay credentials are bearer secrets with a multi-hour lifetime.
          'res.iceServers',
          '*.credential',
        ],
        censor: '[redacted]',
      },
      serializers: {
        req: (request) => ({
          method: request.method,
          url: request.url,
          remoteAddress: request.ip,
        }),
      },
    },

    // Only honour X-Forwarded-* from the reverse proxy. Trusting every hop lets
    // a client spoof its own IP and walk straight past the rate limiter.
    trustProxy: config.http.trustProxy,

    // 8 KB is generous for a display name and denies large-payload abuse.
    bodyLimit: 8 * 1024,

    // Do not echo an attacker-supplied request id back into responses or logs.
    genReqId: () => crypto.randomUUID(),

    // Slowloris mitigation: drop connections that dawdle on headers/body.
    requestTimeout: 15_000,
    connectionTimeout: 30_000,

    // Reject ambiguous URLs before routing, so `/api//rooms` and `/api/rooms/`
    // cannot be used to slip past a path-prefixed rule.
    routerOptions: {
      ignoreTrailingSlash: false,
      ignoreDuplicateSlashes: false,
      caseSensitive: true,
    },

    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',

    /**
     * Strict request validation.
     *
     * Fastify's AJV defaults are tuned for convenience, not for a public
     * endpoint: `coerceTypes` silently turns `{"displayName": 123}` into the
     * string "123", and `removeAdditional` quietly deletes unknown keys rather
     * than rejecting them. Both mean a malformed request is accepted and
     * reinterpreted instead of refused. For an unauthenticated API the right
     * behaviour is to reject anything that is not exactly the expected shape.
     */
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
        useDefaults: false,
        allErrors: false,
      },
    },
  });

  /**
   * Security headers.
   *
   * The API returns only JSON, so its CSP can be maximally restrictive —
   * nothing should ever be loaded or executed from an API response. The HTML
   * document's CSP is set by Caddy, which serves the SPA (see infra/Caddyfile).
   */
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'none'"],
      },
    },
    // 2 years + preload: required for the HSTS preload list. Only ever sent
    // over HTTPS, so a plain-HTTP local dev setup is unaffected.
    strictTransportSecurity: {
      maxAge: 63_072_000,
      includeSubDomains: true,
      preload: true,
    },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    // Fingerprinting the framework buys an attacker a version-specific exploit list.
    hidePoweredBy: true,
    xFrameOptions: { action: 'deny' },
    noSniff: true,
  });

  /**
   * CORS: an explicit allowlist, never a reflected origin and never `*`.
   * Credentials are disabled because the API uses no cookies at all.
   */
  await app.register(cors, {
    origin: (origin, callback) => {
      // Same-origin and non-browser clients send no Origin header.
      if (!origin) return callback(null, true);
      callback(null, config.http.corsOrigins.includes(origin));
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
    maxAge: 600,
  });

  /**
   * Rate limiting, keyed on the real client IP. Per-route overrides live with
   * the routes; this is the global backstop.
   */
  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    // A shared bucket is what makes limits meaningful behind a load balancer;
    // without Redis each replica would enforce only its own fraction of the limit.
    ...(config.redis.url ? { redis: createLimiterRedis() } : {}),
    keyGenerator: (request) => request.ip,
    // Do not reveal the limit ceiling to clients probing for it.
    addHeadersOnExceeding: { 'x-ratelimit-limit': false, 'x-ratelimit-remaining': false },
    errorResponseBuilder: () => ({
      error: 'RATE_LIMITED',
      message: 'Too many requests. Please slow down.',
    }),
  });

  /**
   * CSRF defence.
   *
   * The API holds no ambient authority — no cookies, no sessions — so classic
   * CSRF is structurally impossible: a forged cross-site request carries no
   * credentials and gains the attacker nothing they could not obtain directly.
   * This Origin check is defence in depth against a future change that
   * introduces cookies, and it blocks trivial cross-origin abuse of room
   * creation from other sites.
   */
  app.addHook('onRequest', async (request, reply) => {
    if (!STATE_CHANGING.has(request.method)) return;
    // Webhooks come from LiveKit (no Origin) and carry their own signature.
    if (request.url.startsWith('/api/webhooks/')) return;

    const origin = request.headers.origin;
    if (origin && !config.http.corsOrigins.includes(origin)) {
      request.log.warn({ origin }, 'blocked cross-origin state change');
      return reply.code(403).send({ error: 'FORBIDDEN', message: 'Cross-origin request blocked.' });
    }
  });

  /**
   * Uniform error shape. Internal messages and stack traces stay in the logs;
   * clients receive a generic string so implementation details do not leak.
   */
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;

    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
      return reply.code(500).send({
        error: 'INTERNAL',
        message: 'Something went wrong. Please try again.',
      });
    }

    request.log.info({ err: error, status }, 'request rejected');
    return reply.code(status).send({
      error: error.code ?? 'BAD_REQUEST',
      message: status === 400 ? 'Invalid request.' : error.message,
    });
  });

  app.setNotFoundHandler(
    { preHandler: app.rateLimit({ max: 30, timeWindow: '1 minute' }) },
    async (_request, reply) => reply.code(404).send({ error: 'NOT_FOUND' }),
  );

  await app.register(
    async (api) => {
      await api.register(metaRoutes);
      await api.register(roomRoutes, { nonces });
      if (config.livekit.webhooksEnabled) {
        await api.register(webhookRoutes, { nonces });
      }
    },
    { prefix: '/api' },
  );

  return app;
}
