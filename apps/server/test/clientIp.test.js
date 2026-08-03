/**
 * Client address resolution.
 *
 * This decides who gets rate limited, who can be blocked, and which country a
 * connection is counted against. Two failure modes matter and they pull in
 * opposite directions: believing a forged header lets an attacker walk past
 * every limit here by claiming to be someone else, and *not* believing a real
 * one collapses every user behind a proxy into a single bucket.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// The module carries a Fastify-facing wrapper that reads config, so the config
// module has to be satisfiable before it can be imported at all.
process.env.LIVEKIT_API_KEY ??= 'nme';
process.env.LIVEKIT_API_SECRET ??= 'test-secret-at-least-32-characters-long';
process.env.PUBLIC_LIVEKIT_URL ??= 'wss://sfu.example.com';
process.env.CORS_ORIGINS ??= 'https://meet.example.com';

const { isCloudflareAddress, resolveClientIp } = await import('../dist/lib/clientIp.js');

const CLIENT = '203.0.113.7';
const CLOUDFLARE_EDGE = '172.71.4.9';
const NOT_CLOUDFLARE = '198.51.100.4';

test('Cloudflare ranges are recognised, and nothing else is', () => {
  for (const ip of ['172.71.4.9', '162.158.0.1', '104.16.0.1', '188.114.96.6', '131.0.75.1']) {
    assert.equal(isCloudflareAddress(ip), true, `${ip} is Cloudflare`);
  }

  for (const ip of ['203.0.113.7', '8.8.8.8', '172.31.255.1', '104.15.255.255', '131.0.76.1']) {
    assert.equal(isCloudflareAddress(ip), false, `${ip} is not Cloudflare`);
  }

  // The bug this whole module exists for: Cloudflare's edge is *outside* the
  // Docker bridge range that TRUST_PROXY defaults to, so Fastify stops there.
  assert.equal(isCloudflareAddress('172.31.255.255'), false);
  assert.equal(isCloudflareAddress('172.64.0.0'), true);
});

test('IPv6 Cloudflare ranges are recognised', () => {
  assert.equal(isCloudflareAddress('2606:4700::1'), true);
  assert.equal(isCloudflareAddress('2a06:98c0::1'), true);
  assert.equal(isCloudflareAddress('2001:db8::1'), false);
});

test('the header is ignored unless it is switched on', () => {
  assert.equal(resolveClientIp(CLOUDFLARE_EDGE, CLIENT, false), CLOUDFLARE_EDGE);
});

test('a real Cloudflare request resolves to the client behind it', () => {
  assert.equal(resolveClientIp(CLOUDFLARE_EDGE, CLIENT, true), CLIENT);
});

test('a forged header from a non-Cloudflare peer is refused', () => {
  // Somebody who found the origin address and is claiming to be another user,
  // which would otherwise let them evade a block or exhaust someone else's
  // rate-limit bucket.
  assert.equal(resolveClientIp(NOT_CLOUDFLARE, CLIENT, true), NOT_CLOUDFLARE);
  assert.equal(resolveClientIp(NOT_CLOUDFLARE, '127.0.0.1', true), NOT_CLOUDFLARE);
});

test('a malformed header falls back to the peer rather than being trusted', () => {
  for (const forged of ['', 'not-an-ip', '999.1.1.1', '1.1.1.1, 2.2.2.2', '../../etc/passwd']) {
    assert.equal(resolveClientIp(CLOUDFLARE_EDGE, forged, true), CLOUDFLARE_EDGE, forged);
  }
  assert.equal(resolveClientIp(CLOUDFLARE_EDGE, undefined, true), CLOUDFLARE_EDGE);
});

test('the resolved address is re-serialised, never echoed', () => {
  // A header value is attacker-controlled even when the peer is Cloudflare, and
  // this string becomes a rate-limit key and a blocklist entry.
  assert.equal(resolveClientIp(CLOUDFLARE_EDGE, ' 203.0.113.7 ', true), CLIENT);
  assert.equal(resolveClientIp(CLOUDFLARE_EDGE, '::ffff:203.0.113.7', true), CLIENT);
  assert.equal(resolveClientIp(CLOUDFLARE_EDGE, '2001:DB8::1', true), '2001:0db8:0000:0000:0000:0000:0000:0001');
});

test('an IPv6 Cloudflare edge is trusted the same as a v4 one', () => {
  assert.equal(resolveClientIp('2606:4700::1', CLIENT, true), CLIENT);
});
