import { describe, expect, test } from 'vitest';
import fixture from '../test-fixtures/native-compatibility.json';
import {
  fromBase64Url,
  toBase64Url,
  buildMeetingUrl,
  buildShortMeetingUrl,
  decodeRoomKey,
  deriveRoomId,
  generateRoomKey,
  mediaPassphrase,
  readRoomKeyFromAnyUrl,
  readRoomKeyFromUrl,
  safetyNumber,
} from './e2ee';

describe('mediaPassphrase', () => {
  test('preserves the canonical invitation key for every LiveKit SDK', () => {
    expect(mediaPassphrase(fixture.encodedRoomKey)).toBe(fixture.encodedRoomKey);
    expect(new TextEncoder().encode(mediaPassphrase(fixture.encodedRoomKey))).toHaveLength(43);
  });

  test('never lets malformed material reach a media key provider', () => {
    for (const value of ['', 'short', `${'A'.repeat(42)}=`, `${'A'.repeat(44)}`]) {
      expect(() => mediaPassphrase(value), value).toThrow('invalid room key');
    }
  });
});

describe('generateRoomKey', () => {
  test('produces a 256-bit key in unpadded base64url', () => {
    for (let i = 0; i < 100; i++) {
      const key = generateRoomKey();
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(decodeRoomKey(key).byteLength).toBe(32);
    }
  });

  test('never repeats', () => {
    const keys = new Set(Array.from({ length: 2000 }, generateRoomKey));
    expect(keys.size).toBe(2000);
  });

  test('output is not obviously biased', () => {
    // A broken RNG (all zeroes, a counter) would collapse the byte histogram.
    const counts = new Uint32Array(256);
    for (let i = 0; i < 500; i++) {
      for (const byte of new Uint8Array(decodeRoomKey(generateRoomKey()))) counts[byte]! += 1;
    }
    const expected = (500 * 32) / 256;
    for (const count of counts) {
      expect(count).toBeGreaterThan(expected * 0.4);
      expect(count).toBeLessThan(expected * 1.6);
    }
  });
});

describe('readRoomKeyFromUrl', () => {
  test('round-trips a generated key', () => {
    const key = generateRoomKey();
    expect(readRoomKeyFromUrl(`#k=${key}`)).toBe(key);
    expect(readRoomKeyFromUrl(`k=${key}`)).toBe(key);
  });

  test('ignores unrelated fragment parameters', () => {
    const key = generateRoomKey();
    expect(readRoomKeyFromUrl(`#foo=1&k=${key}&bar=2`)).toBe(key);
  });

  test('rejects anything that is not a well-formed 256-bit key', () => {
    const rejected = [
      '',
      '#',
      '#k=',
      '#nokey=abc',
      '#k=short',
      `#k=${'A'.repeat(42)}`, // one character short
      `#k=${'A'.repeat(44)}`, // one character long
      `#k=${'A'.repeat(42)}+`, // base64, not base64url
      `#k=${'A'.repeat(42)}/`,
      `#k=${'A'.repeat(42)}=`, // padded
      '#k=<script>alert(1)</script>',
    ];
    for (const value of rejected) {
      expect(readRoomKeyFromUrl(value), value).toBeNull();
    }
  });

  test('a malformed key never falls back to a default', () => {
    // The critical property: no derived or constant key may be substituted,
    // because that would silently make the room readable by the server.
    expect(readRoomKeyFromUrl('#k=invalid')).toBeNull();
  });
});

describe('buildMeetingUrl', () => {
  test('places the key in the fragment, never the path or query', () => {
    const key = generateRoomKey();
    const url = new URL(buildMeetingUrl('https://meet.example.com', 'k7de-2mqx-9hbt', key));

    expect(url.pathname).toBe('/r/k7de-2mqx-9hbt');
    expect(url.search).toBe('');
    expect(url.hash).toBe(`#k=${key}`);
    // Anything outside the fragment reaches the server in the request line.
    expect(url.pathname + url.search).not.toContain(key);
  });

  test('the produced URL parses back to the same key', () => {
    const key = generateRoomKey();
    const url = new URL(buildMeetingUrl('https://meet.example.com', 'k7de-2mqx-9hbt', key));
    expect(readRoomKeyFromUrl(url.hash)).toBe(key);
  });
});

describe('deriveRoomId', () => {
  test('matches the native compatibility fixture', async () => {
    expect(await deriveRoomId(fixture.encodedRoomKey)).toBe(fixture.roomId);
    expect(await safetyNumber(fixture.encodedRoomKey)).toBe(fixture.safetyNumber);
  });

  test('is deterministic — every participant computes the same id', async () => {
    const key = generateRoomKey();
    expect(await deriveRoomId(key)).toBe(await deriveRoomId(key));
  });

  test('matches the room-id format the server validates', async () => {
    for (let i = 0; i < 50; i++) {
      expect(await deriveRoomId(generateRoomKey())).toMatch(
        /^[abcdefghjkmnpqrstuvwxyz23456789]{4}-[abcdefghjkmnpqrstuvwxyz23456789]{4}-[abcdefghjkmnpqrstuvwxyz23456789]{4}$/,
      );
    }
  });

  test('different keys give different ids', async () => {
    const ids = new Set(
      await Promise.all(Array.from({ length: 400 }, () => deriveRoomId(generateRoomKey()))),
    );
    expect(ids.size).toBe(400);
  });

  test('the id reveals nothing about the key', async () => {
    // The server sees the id and must not be able to recover the key from it.
    // A digest is one-way, so the check here is that no fragment of the key
    // survives into the identifier.
    const key = generateRoomKey();
    const id = (await deriveRoomId(key)).replace(/-/g, '');
    for (let i = 0; i + 4 <= key.length; i++) {
      expect(id).not.toContain(key.slice(i, i + 4));
    }
  });
});

describe('short links', () => {
  test('carry the key in the fragment, never the path', async () => {
    // The fragment is what keeps the key away from the server and from
    // link-preview crawlers; putting it in the path to save characters would
    // hand it to both.
    const key = generateRoomKey();
    const url = new URL(buildShortMeetingUrl('https://meet.example.com', key));

    expect(url.hash).toBe(`#${key}`);
    expect(url.pathname).toBe('/');
    expect(url.pathname + url.search).not.toContain(key);
  });

  test('are shorter than the long form', async () => {
    const key = generateRoomKey();
    const short = buildShortMeetingUrl('https://meet.example.com', key);
    const long = buildMeetingUrl('https://meet.example.com', 'k7de-2mqx-9hbt', key);
    // Removing "/r/", the 14-character id and "k=", less the "/" that stays.
    expect(short.length).toBeLessThan(long.length);
    expect(long.length - short.length).toBe(18);
  });

  test('round-trip back to the same key', async () => {
    const key = generateRoomKey();
    const url = new URL(buildShortMeetingUrl('https://meet.example.com', key));
    expect(readRoomKeyFromAnyUrl(url.hash)).toBe(key);
  });

  test('the original link format still works', async () => {
    // Links already sitting in calendars and chat histories must keep opening.
    const key = generateRoomKey();
    expect(readRoomKeyFromAnyUrl(`#k=${key}`)).toBe(key);
  });

  test('malformed fragments are rejected in both forms', async () => {
    for (const bad of ['#', '#tooshort', `#${'A'.repeat(42)}`, `#k=${'A'.repeat(44)}`]) {
      expect(readRoomKeyFromAnyUrl(bad)).toBeNull();
    }
  });
});

/**
 * The base64url codec is hand-written rather than `btoa`/`atob`, so that this
 * package runs on Hermes without a polyfill holding the room key. That trade is
 * only sound if the arithmetic is exactly right: an encoder that is subtly
 * wrong still round-trips against its own decoder, and the mistake would only
 * surface as a native client deriving a different key from the same link and
 * silently failing to decrypt anything.
 *
 * So these check against an independent implementation, not against itself.
 */
describe('base64url, cross-checked against Node', () => {
  test('decodes what Node encodes', () => {
    for (let i = 0; i < 500; i++) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const reference = Buffer.from(bytes).toString('base64url');
      expect(new Uint8Array(decodeRoomKey(reference))).toEqual(bytes);
    }
  });

  test('encodes byte for byte what Node encodes', () => {
    // Deliberately driven with known input bytes. Going through
    // `generateRoomKey` instead would prove nothing: its bytes are random and
    // unobservable, so any well-formed 43-character output looks correct — a
    // version of this test written that way passed against an encoder with a
    // shift-by-one defect in it.
    for (let i = 0; i < 500; i++) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      expect(toBase64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
    }
  });

  test('handles every trailing-byte case', () => {
    // 0, 1, and 2 bytes over a multiple of three take different branches, and
    // the last of them is where an encoder typically emits a wrong character.
    for (let length = 0; length <= 66; length++) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      expect(toBase64Url(bytes), `length ${length}`).toBe(
        Buffer.from(bytes).toString('base64url'),
      );
      expect(fromBase64Url(toBase64Url(bytes)), `length ${length}`).toEqual(bytes);
    }
  });

  test('rejects characters outside the alphabet rather than skipping them', () => {
    // Skipping would let several distinct strings decode to one key, so a
    // corrupted link could quietly place someone in a different meeting.
    expect(() => decodeRoomKey('+'.repeat(43))).toThrow();
    expect(() => decodeRoomKey('='.repeat(43))).toThrow();
    expect(() => decodeRoomKey(`${'A'.repeat(42)} `)).toThrow();
  });
});
