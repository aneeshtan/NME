/**
 * Environment parsing and validation.
 *
 * Fail-fast philosophy: a misconfigured security-critical value must crash the
 * process at boot rather than silently degrade at runtime. There is no
 * "development fallback" for secrets — an app that invents its own signing key
 * when the real one is missing is an app that ships with a known key.
 */

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Environment variable ${name} must be an integer in [${min}, ${max}]`);
  }
  return parsed;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function originList(name: string): readonly string[] {
  const list = required(name)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const origin of list) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`${name} contains an invalid origin: ${origin}`);
    }
    // An "origin" is scheme + host + port. A path means someone pasted a URL,
    // which would silently widen or break the CORS check.
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error(`${name} entries must be bare origins (no path): ${origin}`);
    }
  }
  return Object.freeze(list.map((o) => new URL(o).origin));
}

const isProduction = optional('NODE_ENV', 'development') === 'production';

const apiSecret = required('LIVEKIT_API_SECRET');
// LiveKit signs join tokens (HS256) with this value. Under 32 bytes of entropy
// an offline brute-force against a captured token becomes plausible, and a
// forged token grants publish rights in any room.
if (isProduction && apiSecret.length < 32) {
  throw new Error('LIVEKIT_API_SECRET must be at least 32 characters in production');
}

export const config = Object.freeze({
  isProduction,
  logLevel: optional('LOG_LEVEL', isProduction ? 'info' : 'debug'),

  http: Object.freeze({
    host: optional('HOST', '0.0.0.0'),
    port: integer('PORT', 8080, 1, 65535),
    /** `true` trusts every hop; prefer a CIDR so clients cannot spoof X-Forwarded-For. */
    trustProxy: optional('TRUST_PROXY', '127.0.0.1'),
    corsOrigins: originList('CORS_ORIGINS'),
  }),

  livekit: Object.freeze({
    apiKey: required('LIVEKIT_API_KEY'),
    apiSecret,
    /** Internal HTTP endpoint used for room administration. */
    host: optional('LIVEKIT_HOST', 'http://livekit:7880'),
    /** Public WSS endpoint handed to browsers. */
    publicUrl: required('PUBLIC_LIVEKIT_URL'),
    webhooksEnabled: boolean('LIVEKIT_WEBHOOK_ENABLED', true),
  }),

  room: Object.freeze({
    maxParticipants: integer('MAX_PARTICIPANTS', 25, 2, 100),
    emptyTimeout: integer('ROOM_EMPTY_TIMEOUT', 120, 10, 3600),
    departureTimeout: integer('ROOM_DEPARTURE_TIMEOUT', 20, 5, 3600),
    tokenTtlSeconds: integer('TOKEN_TTL', 120, 30, 900),
  }),

  media: Object.freeze({
    videoCodec: (() => {
      const codec = optional('VIDEO_CODEC', 'vp8').toLowerCase();
      if (codec !== 'vp8' && codec !== 'vp9') {
        throw new Error('VIDEO_CODEC must be "vp8" or "vp9"');
      }
      return codec;
    })(),
  }),

  redis: Object.freeze({
    url: optional('REDIS_URL', ''),
    password: optional('REDIS_PASSWORD', ''),
  }),

  /**
   * TURN relay, used only as a fallback for participants whose network blocks
   * direct media. Entirely optional — an unset TURN_URLS simply means those
   * participants cannot connect, which is the pre-existing behaviour.
   */
  turn: Object.freeze(turnConfig()),
});

function turnConfig() {
  const urls = optional('TURN_URLS', '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);

  const authSecret = optional('TURN_AUTH_SECRET', '');
  const username = optional('TURN_USERNAME', '');
  const credential = optional('TURN_CREDENTIAL', '');

  if (urls.length > 0) {
    // Fail at boot rather than at the moment a user on a restricted network
    // tries to join — that failure would be rare, remote, and hard to diagnose.
    //
    // `turns:` (TLS) is required, not preferred. Plain `turn:` would leave the
    // relay control channel and the credential itself readable on the wire, and
    // would not survive the 443-only firewalls this fallback exists to solve.
    for (const url of urls) {
      if (!url.startsWith('turns:')) {
        throw new Error(
          `TURN_URLS must use the turns: (TLS) scheme for encrypted relay traffic; got "${url}"`,
        );
      }
    }

    if (!authSecret && !(username && credential)) {
      throw new Error(
        'TURN_URLS is set, so either TURN_AUTH_SECRET (preferred: ephemeral ' +
          'credentials) or both TURN_USERNAME and TURN_CREDENTIAL must be provided.',
      );
    }

    if (isProduction && authSecret && authSecret.length < 32) {
      throw new Error('TURN_AUTH_SECRET must be at least 32 characters in production');
    }
  }

  return {
    urls: Object.freeze(urls) as readonly string[],
    authSecret,
    username,
    credential,
    /**
     * Credential lifetime. This is a genuine trade-off, not a tuning knob:
     * the relay re-authenticates when an allocation is refreshed, so a
     * credential that expires mid-call drops the media. It must therefore
     * comfortably exceed the longest expected meeting, while a longer window
     * also means a leaked credential stays usable for longer.
     */
    credentialTtl: integer('TURN_CREDENTIAL_TTL', 21_600, 300, 86_400),
  };
}

export type Config = typeof config;
