import { describe, expect, test } from 'vitest';
import { readRoomKeyFromLink } from './deeplink';
import { buildMeetingUrl, buildShortMeetingUrl, generateRoomKey } from './e2ee';

describe('readRoomKeyFromLink', () => {
  test('reads the short link a phone receives from a Universal Link tap', () => {
    const key = generateRoomKey();
    expect(readRoomKeyFromLink(buildShortMeetingUrl('https://meet.example.com', key))).toBe(key);
  });

  test('reads the long link form still sitting in old calendar invitations', () => {
    const key = generateRoomKey();
    const link = buildMeetingUrl('https://meet.example.com', 'k7de-2mqx-9hbt', key);
    expect(readRoomKeyFromLink(link)).toBe(key);
  });

  test('reads a custom-scheme link', () => {
    // `nme://` has no real authority, which is why this is parsed by locating
    // the fragment rather than by constructing a URL.
    const key = generateRoomKey();
    expect(readRoomKeyFromLink(`nme://meet#${key}`)).toBe(key);
    expect(readRoomKeyFromLink(`nme:///#k=${key}`)).toBe(key);
  });

  test('reads a bare key', () => {
    const key = generateRoomKey();
    expect(readRoomKeyFromLink(key)).toBe(key);
    expect(readRoomKeyFromLink(`  ${key}  `)).toBe(key);
  });

  test('the host is ignored, not trusted', () => {
    // The app always talks to the deployment it was built for. A link naming
    // someone else's server must still yield only its key, so that nothing
    // downstream can be pointed at an attacker's control plane.
    const key = generateRoomKey();
    expect(readRoomKeyFromLink(`https://evil.example.net/#${key}`)).toBe(key);
    expect(readRoomKeyFromLink(`https://meet.example.com.evil.net/#${key}`)).toBe(key);
  });

  test('rejects anything without a well-formed key', () => {
    const rejected = [
      '',
      '   ',
      'https://meet.example.com/',
      'https://meet.example.com/#',
      'https://meet.example.com/#notakey',
      `https://meet.example.com/#${'A'.repeat(42)}`,
      `https://meet.example.com/#${'A'.repeat(44)}`,
      // base64 rather than base64url: a link mangled in transit, not a key.
      `https://meet.example.com/#${'A'.repeat(42)}+`,
      'nme://meet',
      'javascript:alert(1)',
    ];
    for (const link of rejected) {
      expect(readRoomKeyFromLink(link), JSON.stringify(link)).toBeNull();
    }
  });

  test('never substitutes a default key for a broken link', () => {
    // The property that matters most here: a malformed link must fail closed.
    // Falling back to any derivable key would place two people in a room they
    // both believe is private, encrypted with something an attacker chose.
    for (let i = 0; i < 50; i++) {
      // 43 is skipped because at that length this is not a broken link at all:
      // `x` is in the base64url alphabet, so 43 of them is a perfectly
      // well-formed — if wildly unlikely — key, and accepting it is correct.
      if (i === 43) continue;
      expect(readRoomKeyFromLink(`https://meet.example.com/#${'x'.repeat(i)}`), `length ${i}`)
        .toBeNull();
    }
  });
});
