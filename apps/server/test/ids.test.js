import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomId, isValidRoomId, createParticipantId } from '../dist/lib/ids.js';

test('room IDs match the canonical 4-4-4 shape', () => {
  for (let i = 0; i < 200; i++) {
    assert.match(createRoomId(), /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  }
});

test('room IDs omit visually ambiguous characters', () => {
  const forbidden = new Set(['0', '1', 'l', 'i', 'o']);
  for (let i = 0; i < 500; i++) {
    for (const ch of createRoomId().replaceAll('-', '')) {
      assert.ok(!forbidden.has(ch), `ambiguous character ${ch} leaked into a room ID`);
    }
  }
});

test('room IDs do not repeat across many draws', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(createRoomId());
  assert.equal(seen.size, 5000);
});

test('symbol distribution shows no modulo bias', () => {
  // Rejection sampling should keep every symbol within a few percent of uniform.
  const counts = new Map();
  const draws = 20000;
  for (let i = 0; i < draws; i++) {
    for (const ch of createRoomId().replaceAll('-', '')) {
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
  }
  const expected = (draws * 12) / 31;
  for (const [symbol, count] of counts) {
    const deviation = Math.abs(count - expected) / expected;
    assert.ok(deviation < 0.12, `symbol ${symbol} deviates ${(deviation * 100).toFixed(1)}%`);
  }
});

test('validator accepts generated IDs and rejects everything else', () => {
  assert.ok(isValidRoomId(createRoomId()));

  const rejected = [
    '',
    'abc',
    'abcd-efgh-ijkl', // contains excluded letters i, l
    'abcd-efgh-jkmn-pqrs', // too many groups
    'ABCD-EFGH-JKMN', // uppercase
    'abcdefghjkmn', // missing separators
    'abcd-efgh-jkm', // short final group
    'abcd_efgh_jkmn',
    'abcd-efgh-jkm\n', // trailing newline must not pass via multiline anchors
    null,
    undefined,
    42,
    {},
    ['abcd-efgh-jkmn'],
  ];
  for (const value of rejected) {
    assert.equal(isValidRoomId(value), false, `should reject ${JSON.stringify(value)}`);
  }
});

test('participant identities are unique and URL-safe', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const id = createParticipantId();
    assert.match(id, /^p_[A-Za-z0-9_-]{16}$/);
    seen.add(id);
  }
  assert.equal(seen.size, 2000);
});
