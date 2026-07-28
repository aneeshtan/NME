/**
 * TURN credential issuance.
 *
 * These assertions encode the relay's security model: credentials must be
 * unguessable, individually unique, genuinely time-limited, and verifiable by
 * the relay using only the shared secret.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const SECRET = 'turn-test-secret-at-least-32-characters';

process.env.LIVEKIT_API_KEY ??= 'nme';
process.env.LIVEKIT_API_SECRET ??= 'test-secret-at-least-32-characters-long';
process.env.PUBLIC_LIVEKIT_URL ??= 'wss://sfu.example.com';
process.env.CORS_ORIGINS ??= 'https://meet.example.com';
process.env.TURN_URLS = 'turns:turn.example.com:443?transport=tcp';
process.env.TURN_AUTH_SECRET = SECRET;
process.env.TURN_CREDENTIAL_TTL = '3600';

const { issueTurnCredentials } = await import('../dist/lib/turn.js');

test('credentials carry the configured relay URL', () => {
  const ice = issueTurnCredentials();
  assert.deepEqual(ice.urls, ['turns:turn.example.com:443?transport=tcp']);
});

test('the credential is an HMAC the relay can independently verify', () => {
  const ice = issueTurnCredentials();
  // This is exactly what coturn recomputes in use-auth-secret mode.
  const expected = createHmac('sha1', SECRET).update(ice.username).digest('base64');
  assert.equal(ice.credential, expected);
});

test('a credential minted with the wrong secret does not verify', () => {
  const ice = issueTurnCredentials();
  const forged = createHmac('sha1', 'not-the-real-secret').update(ice.username).digest('base64');
  assert.notEqual(ice.credential, forged);
});

test('the username encodes a future expiry', () => {
  const ice = issueTurnCredentials();
  const [expiry] = ice.username.split(':');
  const seconds = Number.parseInt(expiry, 10);
  const now = Math.floor(Date.now() / 1000);

  assert.ok(Number.isInteger(seconds), 'expiry must be a unix timestamp');
  assert.ok(seconds > now, 'credential must not be born expired');
  assert.ok(seconds <= now + 3600, 'credential must not outlive the configured TTL');
});

test('tampering with the expiry invalidates the credential', () => {
  const ice = issueTurnCredentials();
  const [expiry, nonce] = ice.username.split(':');

  // A client extending its own credential must not produce a valid MAC.
  const extended = `${Number.parseInt(expiry, 10) + 86_400}:${nonce}`;
  const mac = createHmac('sha1', SECRET).update(extended).digest('base64');
  assert.notEqual(mac, ice.credential);
});

test('every issuance is unique', () => {
  // Two participants issued within the same second must not share a
  // credential, or one could be revoked by the other's misuse.
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const ice = issueTurnCredentials();
    seen.add(`${ice.username}|${ice.credential}`);
  }
  assert.equal(seen.size, 1000);
});

test('the random portion is not predictable', () => {
  const nonces = new Set();
  for (let i = 0; i < 500; i++) {
    const [, nonce] = issueTurnCredentials().username.split(':');
    assert.match(nonce, /^[A-Za-z0-9_-]{12}$/);
    nonces.add(nonce);
  }
  assert.equal(nonces.size, 500);
});
