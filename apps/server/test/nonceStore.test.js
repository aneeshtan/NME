import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryNonceStore } from '../dist/lib/nonceStore.js';

test('a registered nonce can be consumed exactly once', async () => {
  const store = new MemoryNonceStore();
  await store.register('p_abc', 60);

  assert.equal(await store.consume('p_abc'), true, 'first use should succeed');
  assert.equal(await store.consume('p_abc'), false, 'replay must be rejected');

  await store.close();
});

test('an unknown nonce is rejected', async () => {
  const store = new MemoryNonceStore();
  assert.equal(await store.consume('p_never_issued'), false);
  await store.close();
});

test('an expired nonce is rejected', async () => {
  const store = new MemoryNonceStore();
  await store.register('p_expired', 0);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await store.consume('p_expired'), false);
  await store.close();
});

test('concurrent consumption yields exactly one winner', async () => {
  const store = new MemoryNonceStore();
  await store.register('p_race', 60);

  const results = await Promise.all(
    Array.from({ length: 25 }, () => store.consume('p_race')),
  );
  assert.equal(results.filter(Boolean).length, 1);

  await store.close();
});

test('the store stays bounded under flood', async () => {
  const store = new MemoryNonceStore();
  // Deliberately not awaited per iteration: 120k sequential microtask hops cost
  // seconds and prove nothing extra. register() is synchronous internally.
  const writes = [];
  for (let i = 0; i < 120_000; i++) writes.push(store.register(`p_${i}`, 300));
  await Promise.all(writes);
  // Exposed only for this assertion; the cap is 100k.
  assert.ok(store.entries.size <= 100_000);
  await store.close();
});
