/**
 * Verifies the shape of what we hand to clients and accept from LiveKit.
 * These assertions encode the authorisation model — if a grant appears here
 * that should not, a leaked token becomes an administrative credential.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.LIVEKIT_API_KEY ??= 'nme';
process.env.LIVEKIT_API_SECRET ??= 'test-secret-at-least-32-characters-long';
process.env.PUBLIC_LIVEKIT_URL ??= 'wss://sfu.example.com';
process.env.CORS_ORIGINS ??= 'https://meet.example.com';
process.env.TOKEN_TTL ??= '120';

const { issueJoinToken } = await import('../dist/lib/livekit.js');
const { WebhookReceiver } = await import('livekit-server-sdk');

function decodeClaims(jwt) {
  const [, payload] = jwt.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

test('join token is scoped to exactly one room', async () => {
  const { token } = await issueJoinToken('k7de-2mqx-9hbt', 'Alice');
  const claims = decodeClaims(token);

  assert.equal(claims.video.room, 'k7de-2mqx-9hbt');
  assert.equal(claims.video.roomJoin, true);
});

test('join token carries no administrative capability', async () => {
  const { token } = await issueJoinToken('k7de-2mqx-9hbt', 'Alice');
  const grants = decodeClaims(token).video;

  // Each of these would turn a leaked join link into a much larger problem:
  // enumerating live meetings, evicting participants, or starting a recording.
  for (const forbidden of [
    'roomCreate',
    'roomList',
    'roomAdmin',
    'roomRecord',
    'ingressAdmin',
    'recorder',
    'agent',
  ]) {
    assert.notEqual(grants[forbidden], true, `token must not grant ${forbidden}`);
  }

  // Rewriting your own name after joining would allow impersonation.
  assert.notEqual(grants.canUpdateOwnMetadata, true);
  assert.notEqual(grants.hidden, true);
});

test('join token grants only ordinary participation', async () => {
  const { token } = await issueJoinToken('k7de-2mqx-9hbt', 'Alice');
  const grants = decodeClaims(token).video;

  assert.equal(grants.canPublish, true);
  assert.equal(grants.canSubscribe, true);
  // Required for LiveKit's E2EE key ratchet messages.
  assert.equal(grants.canPublishData, true);
});

test('join token expires quickly', async () => {
  const { token } = await issueJoinToken('k7de-2mqx-9hbt', 'Alice');
  const claims = decodeClaims(token);
  const lifetime = claims.exp - Math.floor(Date.now() / 1000);

  // A short window is the primary replay defence: the token only needs to
  // survive the moment between issuance and the WebSocket connect.
  assert.ok(lifetime > 0, 'token must not be born expired');
  assert.ok(lifetime <= 121, `token lifetime ${lifetime}s is too long`);
});

test('each token gets a unique, unguessable identity', async () => {
  const identities = new Set();
  for (let i = 0; i < 500; i++) {
    const { identity } = await issueJoinToken('k7de-2mqx-9hbt', 'Alice');
    identities.add(identity);
  }
  assert.equal(identities.size, 500);
});

test('the display name reaches LiveKit as the server normalised it', async () => {
  const { token } = await issueJoinToken('k7de-2mqx-9hbt', 'Alice');
  assert.equal(decodeClaims(token).name, 'Alice');
});

test('webhook receiver accepts a correctly signed delivery', async () => {
  const { AccessToken } = await import('livekit-server-sdk');
  const { createHash } = await import('node:crypto');

  const body = JSON.stringify({
    event: 'participant_joined',
    room: { name: 'k7de-2mqx-9hbt' },
    participant: { identity: 'p_abc' },
  });

  const hash = createHash('sha256').update(body).digest('base64');
  const signer = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity: process.env.LIVEKIT_API_KEY,
    ttl: 60,
  });
  signer.sha256 = hash;
  const authHeader = await signer.toJwt();

  const receiver = new WebhookReceiver(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
  );
  const event = await receiver.receive(body, authHeader);
  assert.equal(event.event, 'participant_joined');
  assert.equal(event.participant.identity, 'p_abc');
});

test('webhook receiver rejects an unsigned delivery', async () => {
  const receiver = new WebhookReceiver(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
  );
  const body = JSON.stringify({ event: 'participant_joined' });

  await assert.rejects(() => receiver.receive(body, undefined));
  await assert.rejects(() => receiver.receive(body, 'garbage'));
});

test('webhook receiver rejects a body tampered with after signing', async () => {
  const { AccessToken } = await import('livekit-server-sdk');
  const { createHash } = await import('node:crypto');

  const original = JSON.stringify({
    event: 'participant_joined',
    room: { name: 'k7de-2mqx-9hbt' },
    participant: { identity: 'p_abc' },
  });

  const signer = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity: process.env.LIVEKIT_API_KEY,
    ttl: 60,
  });
  signer.sha256 = createHash('sha256').update(original).digest('base64');
  const authHeader = await signer.toJwt();

  // Same signature, different payload — the body hash must catch this.
  const tampered = original.replace('p_abc', 'p_victim');
  const receiver = new WebhookReceiver(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
  );
  await assert.rejects(() => receiver.receive(tampered, authHeader));
});

test('a token signed with the wrong secret is not accepted', async () => {
  const { AccessToken } = await import('livekit-server-sdk');
  const { TokenVerifier } = await import('livekit-server-sdk');

  const forged = new AccessToken('nme', 'an-attackers-guess-of-the-secret-value', {
    identity: 'p_attacker',
    ttl: 60,
  });
  forged.addGrant({ roomJoin: true, room: 'k7de-2mqx-9hbt', roomAdmin: true });

  const forgedJwt = await forged.toJwt();
  const verifier = new TokenVerifier(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
  );
  await assert.rejects(() => verifier.verify(forgedJwt));
});
