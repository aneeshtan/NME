/**
 * Lobby admission control.
 *
 * These assertions encode the property the lobby exists for: nobody obtains a
 * join token without an explicit decision from a holder of the host secret.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHostKey,
  createKnockId,
  hashHostKey,
  hostKeyMatches,
  MemoryLobbyStore,
} from '../dist/lib/lobby.js';

test('host keys are unguessable and unique', () => {
  const keys = new Set();
  for (let i = 0; i < 2000; i++) {
    const key = createHostKey();
    assert.match(key, /^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url
    keys.add(key);
  }
  assert.equal(keys.size, 2000);
});

test('knock ids are unguessable and unique', () => {
  const ids = new Set();
  for (let i = 0; i < 2000; i++) {
    const id = createKnockId();
    assert.match(id, /^[A-Za-z0-9_-]{24}$/); // 18 bytes
    ids.add(id);
  }
  assert.equal(ids.size, 2000);
});

test('the host key is never stored in the clear', () => {
  const key = createHostKey();
  const hash = hashHostKey(key);
  assert.notEqual(hash, key);
  assert.match(hash, /^[0-9a-f]{64}$/);
  // A stored hash must not reveal the secret that produced it.
  assert.ok(!hash.includes(key.slice(0, 8)));
});

test('only the correct host key verifies', () => {
  const key = createHostKey();
  const hash = hashHostKey(key);

  assert.equal(hostKeyMatches(hash, key), true);
  assert.equal(hostKeyMatches(hash, createHostKey()), false);
  assert.equal(hostKeyMatches(hash, ''), false);
  // A prefix of the real key must not pass — the failure mode a naive
  // startsWith or truncating comparison would introduce.
  assert.equal(hostKeyMatches(hash, key.slice(0, 20)), false);
  assert.equal(hostKeyMatches(hash, key + 'x'), false);
});

test('a knock starts pending and carries no token', async () => {
  const store = new MemoryLobbyStore();
  const id = createKnockId();
  await store.knock('k7de-2mqx-9hbt', {
    id,
    displayName: 'Alice',
    status: 'pending',
    createdAt: Date.now(),
  }, 60);

  const knock = await store.getKnock('k7de-2mqx-9hbt', id);
  assert.equal(knock.status, 'pending');
  assert.equal(knock.token, undefined, 'a pending knock must never hold a token');

  await store.close();
});

test('knocks are scoped to their room', async () => {
  // A knock id from one meeting must not resolve in another, or a host could
  // admit someone into a room they never knocked on.
  const store = new MemoryLobbyStore();
  const id = createKnockId();
  await store.knock('aaaa-bbbb-cccc', {
    id, displayName: 'Alice', status: 'pending', createdAt: Date.now(),
  }, 60);

  assert.notEqual(await store.getKnock('aaaa-bbbb-cccc', id), null);
  assert.equal(await store.getKnock('dddd-eeee-ffff', id), null);

  await store.close();
});

test('a lobby is only enabled for the room it was created for', async () => {
  const store = new MemoryLobbyStore();
  const key = createHostKey();
  await store.enable('aaaa-bbbb-cccc', hashHostKey(key), 60);

  assert.equal(await store.isEnabled('aaaa-bbbb-cccc'), true);
  assert.equal(await store.isEnabled('dddd-eeee-ffff'), false);
  // The same secret must not unlock a different room.
  assert.equal(await store.verifyHost('dddd-eeee-ffff', key), false);

  await store.close();
});

test('an expired lobby stops verifying', async () => {
  const store = new MemoryLobbyStore();
  const key = createHostKey();
  await store.enable('aaaa-bbbb-cccc', hashHostKey(key), 0);
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(await store.isEnabled('aaaa-bbbb-cccc'), false);
  assert.equal(await store.verifyHost('aaaa-bbbb-cccc', key), false);

  await store.close();
});

test('listing returns only knocks for that room', async () => {
  const store = new MemoryLobbyStore();
  for (const [room, name] of [
    ['aaaa-bbbb-cccc', 'Alice'],
    ['aaaa-bbbb-cccc', 'Bob'],
    ['dddd-eeee-ffff', 'Mallory'],
  ]) {
    await store.knock(room, {
      id: createKnockId(), displayName: name, status: 'pending', createdAt: Date.now(),
    }, 60);
  }

  const names = (await store.listKnocks('aaaa-bbbb-cccc')).map((k) => k.displayName).sort();
  assert.deepEqual(names, ['Alice', 'Bob']);

  await store.close();
});

test('the knock store stays bounded under flood', async () => {
  // The knock endpoint is unauthenticated, so unbounded growth would be a
  // denial-of-service vector.
  const store = new MemoryLobbyStore();
  const writes = [];
  for (let i = 0; i < 12_000; i++) {
    writes.push(store.knock('aaaa-bbbb-cccc', {
      id: `k${i}`, displayName: 'x', status: 'pending', createdAt: Date.now(),
    }, 300));
  }
  await Promise.all(writes);
  assert.ok(store.knocks.size <= 10_000);
  await store.close();
});
