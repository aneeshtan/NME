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
