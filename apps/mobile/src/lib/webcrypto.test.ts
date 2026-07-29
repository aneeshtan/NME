/**
 * Proof that the shim and real WebCrypto produce the same bytes.
 *
 * This is the test that decides whether chat works across platforms. A browser
 * seals a message with the WebCrypto its engine provides; a phone opens it with
 * the pure-JavaScript implementation in `webcrypto.ts`. If those two disagree
 * anywhere — the HKDF inputs, the tag position, the nonce handling — messages
 * simply never arrive, and nothing anywhere logs an error, because a failed
 * decryption is indistinguishable from a message meant for someone else.
 *
 * So this does not check the shim against itself. It runs @nme/core's real
 * `deriveChatKey`, `sealMessage`, and `openMessage` twice, once against each
 * implementation, and crosses the results over.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { webcrypto as nodeWebcrypto } from 'node:crypto';
import { deriveChatKey, generateRoomKey, openMessage, sealMessage } from '@nme/core';
import { nobleSubtle } from './webcrypto';

const realSubtle = nodeWebcrypto.subtle as SubtleCrypto;

/** Runs `body` with `crypto.subtle` swapped for the given implementation. */
async function withSubtle<T>(subtle: SubtleCrypto, body: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', {
    // Methods are named explicitly rather than spread: `getRandomValues` lives
    // on Crypto's prototype, so `{ ...nodeWebcrypto }` silently produces an
    // object without it.
    value: {
      subtle,
      getRandomValues: (array: ArrayBufferView) => nodeWebcrypto.getRandomValues(array as never),
      randomUUID: () => nodeWebcrypto.randomUUID(),
    },
    configurable: true,
    writable: true,
  });
  try {
    return await body();
  } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
  }
}

afterEach(() => {
  // Nothing should leak a swapped global into the next test.
  expect(globalThis.crypto).toBeDefined();
});

describe('the shim agrees with WebCrypto', () => {
  test('SHA-256 digests match byte for byte', async () => {
    // Room ids and safety numbers are derived from this. A mismatch would put a
    // phone and a browser holding the same link into two different rooms.
    for (const length of [0, 1, 31, 32, 33, 64, 1000]) {
      const data = nodeWebcrypto.getRandomValues(new Uint8Array(length));
      const mine = new Uint8Array(await nobleSubtle.digest('SHA-256', data));
      const theirs = new Uint8Array(await realSubtle.digest('SHA-256', data));
      expect(Array.from(mine), `length ${length}`).toEqual(Array.from(theirs));
    }
  });

  test('a message sealed in a browser opens on a phone', async () => {
    const roomKey = generateRoomKey();

    const sealed = await withSubtle(realSubtle, async () => {
      const key = await deriveChatKey(roomKey);
      return sealMessage(key, { type: 'chat', at: 1, text: 'sent from the web client' });
    });

    const opened = await withSubtle(nobleSubtle, async () => {
      const key = await deriveChatKey(roomKey);
      return openMessage(key, sealed);
    });

    expect(opened).toEqual({ type: 'chat', at: 1, text: 'sent from the web client' });
  });

  test('a message sealed on a phone opens in a browser', async () => {
    const roomKey = generateRoomKey();

    const sealed = await withSubtle(nobleSubtle, async () => {
      const key = await deriveChatKey(roomKey);
      return sealMessage(key, { type: 'chat', at: 2, text: 'sent from the phone' });
    });

    const opened = await withSubtle(realSubtle, async () => {
      const key = await deriveChatKey(roomKey);
      return openMessage(key, sealed);
    });

    expect(opened).toEqual({ type: 'chat', at: 2, text: 'sent from the phone' });
  });

  test('HKDF derives the identical key, not merely a compatible one', async () => {
    // Encrypting the same plaintext with the same nonce under both keys must
    // give identical ciphertext, which it can only do if the keys are equal.
    const roomKey = generateRoomKey();
    const iv = nodeWebcrypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode('identical or not at all');

    const cipher = async (subtle: SubtleCrypto) =>
      withSubtle(subtle, async () => {
        const key = await deriveChatKey(roomKey);
        return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
      });

    expect(Array.from(await cipher(nobleSubtle))).toEqual(Array.from(await cipher(realSubtle)));
  });

  test('every message type survives the crossing, at every size', async () => {
    const roomKey = generateRoomKey();
    const messages = [
      { type: 'chat', at: 1, text: 'x' },
      { type: 'chat', at: 2, text: 'a'.repeat(1900) },
      { type: 'chat', at: 3, text: 'unicode: ✓ 日本語 🎉' },
      { type: 'reaction', at: 4, emoji: '👍' },
      { type: 'hand', at: 5, up: true },
    ] as const;

    for (const message of messages) {
      const sealed = await withSubtle(realSubtle, async () =>
        sealMessage(await deriveChatKey(roomKey), message),
      );
      const opened = await withSubtle(nobleSubtle, async () =>
        openMessage(await deriveChatKey(roomKey), sealed),
      );
      expect(opened, message.type).toEqual(message);
    }
  });

  test('a tampered envelope is rejected by the shim too', async () => {
    // AES-GCM authenticates. If the shim accepted a modified ciphertext, the
    // phone would be the weak point in a system the browser gets right.
    const roomKey = generateRoomKey();
    const sealed = await withSubtle(realSubtle, async () =>
      sealMessage(await deriveChatKey(roomKey), { type: 'chat', at: 1, text: 'original' }),
    );

    const tampered = new Uint8Array(sealed);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0xff;

    const opened = await withSubtle(nobleSubtle, async () =>
      openMessage(await deriveChatKey(roomKey), tampered),
    );
    expect(opened).toBeNull();
  });

  test("another room's key cannot open the message", async () => {
    const sealed = await withSubtle(realSubtle, async () =>
      sealMessage(await deriveChatKey(generateRoomKey()), { type: 'chat', at: 1, text: 'secret' }),
    );
    const opened = await withSubtle(nobleSubtle, async () =>
      openMessage(await deriveChatKey(generateRoomKey()), sealed),
    );
    expect(opened).toBeNull();
  });
});

describe('unimplemented operations fail loudly', () => {
  test('an unsupported algorithm throws rather than returning something wrong', async () => {
    // The shim covers exactly what @nme/core uses. A future caller reaching for
    // more should get an error here, not a silent behavioural difference from
    // the browser that only shows up on a device.
    await expect(nobleSubtle.digest('SHA-1', new Uint8Array(4))).rejects.toThrow(/SHA-256 only/);
    await expect(
      nobleSubtle.importKey('jwk', new Uint8Array(32) as never, 'HKDF', false, ['deriveKey']),
    ).rejects.toThrow(/'raw' only/);
    await expect(
      nobleSubtle.importKey('raw', new Uint8Array(32), 'PBKDF2', false, ['deriveKey']),
    ).rejects.toThrow(/HKDF and AES-GCM only/);
  });
});
