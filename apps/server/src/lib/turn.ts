/**
 * TURN relay credentials.
 *
 * A TURN relay is only reached when a participant's network blocks direct
 * media (the 443-only corporate firewall case). It carries media that is
 * already encrypted twice over — DTLS-SRTP on the wire, and the application's
 * own AES-GCM frame encryption inside that — so the relay forwards bytes it
 * cannot read. Adding it does not weaken the encryption model; it only adds a
 * party that can observe *that* a connection exists.
 *
 * Three properties keep that addition as small as possible:
 *
 *  1. Credentials are issued only to clients that have already failed a direct
 *     connection, never to every joiner. Most participants never touch this.
 *  2. Credentials are short-lived and per-participant, so nothing long-lived is
 *     embedded in the frontend bundle where anyone could lift it.
 *  3. Only `turns:` (TLS) URLs are ever handed to a client. Plain `turn:` would
 *     expose the relay control channel to a passive observer and would not
 *     survive a 443-only firewall anyway.
 *
 * Three provisioning modes, in order of preference:
 *
 *  - **Cloudflare Realtime** — credentials minted per participant through
 *    Cloudflare's API. Short-lived and individually revocable.
 *  - **Ephemeral HMAC** — self-hosted coturn in `use-auth-secret` mode.
 *  - **Static** — a fixed username/password from a hosted provider. Weakest:
 *    these never expire, so a leak lasts until rotated by hand.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { config } from '../config.js';

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** Shape of a Cloudflare `generate-ice-servers` response. */
interface CloudflareIceResponse {
  iceServers?: Array<{
    urls?: string[];
    username?: string;
    credential?: string;
  }>;
}

/**
 * Cloudflare's API is on the critical path of an already-degraded join, so it
 * gets a tight budget. Exceeding it degrades to "no relay available" rather
 * than leaving the user on a spinner.
 */
const CLOUDFLARE_TIMEOUT_MS = 5_000;

/**
 * Mints relay credentials for a single participant.
 *
 * Returns `null` when no relay is configured, or when the upstream provider
 * could not be reached — the caller treats both as "no relay available".
 */
export async function issueTurnCredentials(
  log?: { warn: (obj: unknown, msg: string) => void },
): Promise<IceServer | null> {
  const { cloudflare, urls, authSecret, username, credential, credentialTtl } = config.turn;

  if (cloudflare.keyId && cloudflare.apiToken) {
    return fetchCloudflareCredentials(credentialTtl, log);
  }

  if (urls.length === 0) return null;

  if (authSecret) {
    /**
     * Ephemeral-credential scheme from the TURN REST API draft (coturn's
     * `use-auth-secret` mode):
     *
     *     username   = <unix-expiry>:<random>
     *     credential = base64(HMAC-SHA1(secret, username))
     *
     * The relay recomputes the HMAC from the shared secret and rejects anything
     * expired, so credentials cannot be minted by a client or replayed past
     * their window. HMAC-SHA1 is not a free choice — it is what the scheme and
     * every compatible relay implement. It remains sound as a MAC; SHA-1's
     * collision weaknesses do not apply to the HMAC construction.
     */
    const expiry = Math.floor(Date.now() / 1000) + credentialTtl;
    const ephemeralUser = `${expiry}:${randomBytes(9).toString('base64url')}`;
    const mac = createHmac('sha1', authSecret).update(ephemeralUser).digest('base64');

    return { urls: [...urls], username: ephemeralUser, credential: mac };
  }

  // Static credentials, for hosted relays that do not support the REST scheme.
  // The boot-time check in config.ts refuses to start without one form or other.
  return { urls: [...urls], username, credential };
}

/**
 * Requests per-participant credentials from Cloudflare Realtime.
 *
 * The API token authenticates *this server* to Cloudflare and must never reach
 * a browser — only the derived, expiring credentials are sent onward.
 */
async function fetchCloudflareCredentials(
  ttlSeconds: number,
  log?: { warn: (obj: unknown, msg: string) => void },
): Promise<IceServer | null> {
  const { keyId, apiToken } = config.turn.cloudflare;
  const endpoint = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(
    keyId,
  )}/credentials/generate-ice-servers`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: ttlSeconds }),
      signal: AbortSignal.timeout(CLOUDFLARE_TIMEOUT_MS),
    });

    if (!response.ok) {
      // The body may echo request details; log only the status so a token or
      // credential can never reach the log through an error path. The hint is
      // derived from the status alone and adds no information from the
      // response, so it stays on the right side of that line — while turning a
      // bare number into the one sentence an operator actually needs.
      log?.warn(
        { status: response.status, hint: cloudflareFailureHint(response.status) },
        'cloudflare turn credential request failed',
      );
      return null;
    }

    const body = (await response.json()) as CloudflareIceResponse;
    return selectSecureIceServer(body);
  } catch (error) {
    log?.warn(
      { err: error instanceof Error ? error.name : 'unknown' },
      'cloudflare turn credential request errored',
    );
    return null;
  }
}

/**
 * Reduces a Cloudflare response to a single TLS-only ICE server.
 *
 * Cloudflare returns a STUN entry plus a TURN entry advertising six URLs:
 * plain `turn:` over UDP/TCP on several ports, and `turns:` on 5349 and 443.
 * Handing all of those to the browser would let ICE select an unencrypted
 * relay path, silently defeating the `turns:`-only guarantee enforced
 * everywhere else. Only the TLS URLs survive.
 *
 * Both TLS ports are kept: 443 is the one that traverses a 443-only firewall,
 * while 5349 costs nothing extra and helps where 443 egress is proxied.
 */
export function selectSecureIceServer(body: CloudflareIceResponse): IceServer | null {
  const entries = body.iceServers ?? [];

  for (const entry of entries) {
    // The STUN-only entry carries no credentials and is not usable for relaying.
    if (!entry.username || !entry.credential) continue;

    const secureUrls = (entry.urls ?? []).filter((url) => url.startsWith('turns:'));
    if (secureUrls.length === 0) continue;

    return {
      urls: secureUrls,
      username: entry.username,
      credential: entry.credential,
    };
  }

  return null;
}

/**
 * Turns a Cloudflare HTTP status into the cause an operator can act on.
 *
 * Relay failures are, by their nature, discovered by someone on a network that
 * blocks direct media — often a person who cannot easily be asked to try
 * things. So the one log line this produces has to carry the diagnosis, not
 * just the symptom.
 *
 * The 404 is worth naming explicitly: the endpoint path is fixed and correct,
 * so a 404 can only mean the key in the URL does not exist. In practice that is
 * almost always the Cloudflare *account* ID sitting in CLOUDFLARE_TURN_KEY_ID
 * — the two are both opaque hex strings, they appear on adjacent pages of the
 * dashboard, and Cloudflare's own documentation uses both names for this path.
 */
function cloudflareFailureHint(status: number): string {
  if (status === 401 || status === 403) {
    return 'CLOUDFLARE_TURN_API_TOKEN was rejected — check the token and that it belongs to this TURN key';
  }
  if (status === 404) {
    return 'CLOUDFLARE_TURN_KEY_ID not found — this must be the TURN key ID from Realtime > TURN Keys, not the account ID';
  }
  if (status === 429) {
    return 'rate limited by Cloudflare';
  }
  if (status >= 500) {
    return 'Cloudflare is failing; this should resolve without action';
  }
  return 'unexpected status from Cloudflare';
}
