import { describe, expect, test } from 'vitest';
import { buildMeetingUrl, decodeRoomKey, generateRoomKey, readRoomKeyFromUrl } from './e2ee';

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
