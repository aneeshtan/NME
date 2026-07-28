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
 *  2. Credentials are ephemeral and HMAC-derived, so nothing long-lived is
 *     embedded in the frontend bundle where anyone could lift it.
 *  3. Only `turns:` (TLS) URLs are accepted. Plain `turn:` would expose the
 *     relay control channel to a passive observer and would not survive a
 *     443-only firewall anyway.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { config } from '../config.js';

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * Mints relay credentials for a single participant.
 *
 * When `TURN_AUTH_SECRET` is set, this implements the ephemeral-credential
 * scheme from the TURN REST API draft (coturn's `use-auth-secret` mode):
 *
 *     username   = <unix-expiry>:<random>
 *     credential = base64(HMAC-SHA1(secret, username))
 *
 * The relay recomputes the HMAC from the shared secret and rejects anything
 * expired, so credentials cannot be minted by a client or replayed past their
 * window. HMAC-SHA1 is not a free choice here — it is what the scheme and
 * every compatible relay implement. It remains sound as a MAC; SHA-1's
 * collision weaknesses do not apply to HMAC construction.
 *
 * Returns `null` when no relay is configured, which is the normal state for a
 * deployment that has not needed one.
 */
export function issueTurnCredentials(): IceServer | null {
  const { urls, authSecret, username, credential, credentialTtl } = config.turn;
  if (urls.length === 0) return null;

  if (authSecret) {
    // Second-resolution expiry, plus randomness so two participants issued in
    // the same second never share a credential.
    const expiry = Math.floor(Date.now() / 1000) + credentialTtl;
    const ephemeralUser = `${expiry}:${randomBytes(9).toString('base64url')}`;
    const mac = createHmac('sha1', authSecret).update(ephemeralUser).digest('base64');

    return { urls: [...urls], username: ephemeralUser, credential: mac };
  }

  // Static credentials, for hosted relays that do not support the REST scheme.
  // Weaker: they cannot expire, so a leak lasts until rotated by hand. The
  // boot-time check in config.ts refuses to start without one form or the other.
  return { urls: [...urls], username, credential };
}
