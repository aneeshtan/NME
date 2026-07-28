import { describe, expect, test } from 'vitest';
import { deriveChatKey, openMessage, sealMessage } from './messaging';
import { generateRoomKey } from './e2ee';

const roomKey = generateRoomKey();

describe('chat encryption', () => {
  test('a message round-trips', async () => {
    const key = await deriveChatKey(roomKey);
    const sealed = await sealMessage(key, { type: 'chat', at: 1, text: 'hello' });
    expect(await openMessage(key, sealed)).toEqual({ type: 'chat', at: 1, text: 'hello' });
  });

  test('plaintext never appears in the envelope', async () => {
    // The whole point: the SFU relays this and must learn nothing from it.
    const key = await deriveChatKey(roomKey);
    const secret = 'launch-code-alpha';
    const sealed = await sealMessage(key, { type: 'chat', at: 1, text: secret });

    expect(new TextDecoder().decode(sealed)).not.toContain(secret);
    expect(new TextDecoder().decode(sealed)).not.toContain('chat');
  });

  test('a different room key cannot decrypt', async () => {
    const sealed = await sealMessage(await deriveChatKey(roomKey), {
      type: 'chat',
      at: 1,
      text: 'private',
    });
    const otherKey = await deriveChatKey(generateRoomKey());
    expect(await openMessage(otherKey, sealed)).toBeNull();
  });

  test('the chat key is not the raw room key', async () => {
    // Domain separation: media and chat must not share key material, so that a
    // problem in one context cannot undermine the other.
    const key = await deriveChatKey(roomKey);
    const raw = await crypto.subtle
      .importKey('raw', Uint8Array.from(atob(roomKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)), 'AES-GCM', false, ['decrypt'])
      .catch(() => null);

    const sealed = await sealMessage(key, { type: 'chat', at: 1, text: 'x' });
    if (raw) {
      const iv = sealed.slice(0, 12);
      await expect(
        crypto.subtle.decrypt({ name: 'AES-GCM', iv }, raw, sealed.slice(12)),
      ).rejects.toThrow();
    }
  });

  test('every message uses a fresh IV', async () => {
    // Reusing an IV under AES-GCM leaks the authentication key, not just one
    // plaintext, so this is a hard requirement rather than hygiene.
    const key = await deriveChatKey(roomKey);
    const ivs = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const sealed = await sealMessage(key, { type: 'chat', at: i, text: 'same' });
      ivs.add(Array.from(sealed.slice(0, 12)).join(','));
    }
    expect(ivs.size).toBe(200);
  });

  test('identical plaintexts produce different ciphertexts', async () => {
    const key = await deriveChatKey(roomKey);
    const a = await sealMessage(key, { type: 'chat', at: 1, text: 'repeat' });
    const b = await sealMessage(key, { type: 'chat', at: 1, text: 'repeat' });
    expect(Array.from(a).join()).not.toBe(Array.from(b).join());
  });

  test('a tampered envelope is rejected', async () => {
    const key = await deriveChatKey(roomKey);
    const sealed = await sealMessage(key, { type: 'chat', at: 1, text: 'original' });

    const tampered = new Uint8Array(sealed);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0xff;
    // AES-GCM authenticates, so a flipped bit must fail rather than decode.
    expect(await openMessage(key, tampered)).toBeNull();
  });

  test('malformed input is rejected without throwing', async () => {
    const key = await deriveChatKey(roomKey);
    for (const bad of [new Uint8Array(0), new Uint8Array(5), new Uint8Array(13)]) {
      expect(await openMessage(key, bad)).toBeNull();
    }
  });

  test('oversized payloads are refused before decryption', async () => {
    const key = await deriveChatKey(roomKey);
    expect(await openMessage(key, new Uint8Array(17 * 1024))).toBeNull();
  });

  test('mute requests round-trip', async () => {
    const key = await deriveChatKey(roomKey);
    const sealed = await sealMessage(key, { type: 'mute-request', at: 5 });
    expect(await openMessage(key, sealed)).toEqual({ type: 'mute-request', at: 5 });
  });

  test('unknown message types are dropped', async () => {
    // A peer shares the room key, so they can produce valid ciphertext. The
    // decoded object is still untrusted and must be shape-checked.
    const key = await deriveChatKey(roomKey);
    const sealed = await sealMessage(key, { type: 'evil', at: 1 } as never);
    expect(await openMessage(key, sealed)).toBeNull();
  });

  test('chat text is length-capped on receipt', async () => {
    const key = await deriveChatKey(roomKey);
    const sealed = await sealMessage(key, {
      type: 'chat',
      at: 1,
      text: 'x'.repeat(5000),
    });
    const opened = await openMessage(key, sealed);
    expect(opened?.type).toBe('chat');
    expect((opened as { text: string }).text.length).toBeLessThanOrEqual(2000);
  });
});

describe('poll and timebox messages', () => {
  test('a poll round-trips encrypted', async () => {
    const key = await deriveChatKey(roomKey);
    const sealed = await sealMessage(key, {
      type: 'poll',
      at: 1,
      id: 'p1',
      question: 'Ship on Friday?',
    });
    // The server relays this and must learn neither the question nor the vote.
    expect(new TextDecoder().decode(sealed)).not.toContain('Friday');
    expect(await openMessage(key, sealed)).toEqual({
      type: 'poll',
      at: 1,
      id: 'p1',
      question: 'Ship on Friday?',
    });
  });

  test('votes outside the fixed choice set are dropped', async () => {
    // A peer holds the room key and can produce valid ciphertext, so the choice
    // is attacker-controlled until it is checked against the allow-list.
    const key = await deriveChatKey(roomKey);
    const sealed = await sealMessage(key, {
      type: 'vote',
      at: 1,
      pollId: 'p1',
      choice: 'maybe' as never,
    });
    expect(await openMessage(key, sealed)).toBeNull();
  });

  test('a poll question is length-capped on receipt', async () => {
    const key = await deriveChatKey(roomKey);
    const sealed = await sealMessage(key, {
      type: 'poll',
      at: 1,
      id: 'p1',
      question: 'q'.repeat(1000),
    });
    const opened = await openMessage(key, sealed);
    expect((opened as { question: string }).question.length).toBeLessThanOrEqual(140);
  });

  test('an absurd timebox end is rejected', async () => {
    // This value drives a timer on every client, so a peer must not be able to
    // set a countdown years long or in the distant past.
    const key = await deriveChatKey(roomKey);
    for (const endsAt of [Date.now() + 400 * 24 * 3600_000, -1, 0]) {
      const sealed = await sealMessage(key, { type: 'timebox', at: 1, endsAt });
      expect(await openMessage(key, sealed), String(endsAt)).toBeNull();
    }
  });

  test('a non-finite end degrades to clearing the timer, not to a mad one', async () => {
    // JSON has no representation for Infinity, so it serialises to null — which
    // is already the "clear" signal any peer may send. Worth pinning down
    // because the safe outcome here is an accident of the encoding, not of the
    // validation, and a future change to the wire format could alter it.
    const key = await deriveChatKey(roomKey);
    const sealed = await sealMessage(key, {
      type: 'timebox',
      at: 1,
      endsAt: Number.POSITIVE_INFINITY,
    });
    expect(await openMessage(key, sealed)).toEqual({ type: 'timebox', at: 1, endsAt: null });
  });

  test('a sensible timebox is accepted, and clearing it works', async () => {
    const key = await deriveChatKey(roomKey);
    const endsAt = Date.now() + 30 * 60_000;
    expect(await openMessage(key, await sealMessage(key, { type: 'timebox', at: 1, endsAt })))
      .toEqual({ type: 'timebox', at: 1, endsAt });
    expect(
      await openMessage(key, await sealMessage(key, { type: 'timebox', at: 1, endsAt: null })),
    ).toEqual({ type: 'timebox', at: 1, endsAt: null });
  });
});
