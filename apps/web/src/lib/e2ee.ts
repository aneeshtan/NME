/**
 * End-to-end encryption key material.
 *
 * The threat model: the SFU forwards media between participants, so it sees
 * every packet. Standard WebRTC (DTLS-SRTP) encrypts each *hop*, which means
 * the server can decrypt, inspect, and record everything. E2EE removes the
 * server from the trust boundary entirely — frames are encrypted in the sender's
 * browser and decrypted only in receivers' browsers.
 *
 * Key distribution without accounts:
 *
 *   https://meet.example.com/r/k7de-2mqx-9hbt#k=<256-bit key, base64url>
 *
 * The fragment (everything after `#`) is never transmitted in an HTTP request.
 * The server issues the room ID and the join token, but has no way to learn the
 * key — so possession of the *link* grants access, while possession of the
 * *server* does not. This is the same model as a Signal group invite link, and
 * it is the strongest arrangement achievable without a user directory.
 *
 * What this does and does not protect:
 *   ✔ Audio, video, and screen-share content are unreadable by the server.
 *   ✔ A compromised or subpoenaed SFU yields ciphertext only.
 *   ✘ Metadata (who joined, when, how much bandwidth) is visible to the server.
 *   ✘ Anyone with the link can join. Treat the link as the secret it is.
 */

/** AES-GCM 256. Matches the key length LiveKit's E2EE worker expects. */
const KEY_BYTES = 32;
const FRAGMENT_PARAM = 'k';

/** Generates a fresh room key from the platform CSPRNG. */
export function generateRoomKey(): string {
  const bytes = new Uint8Array(KEY_BYTES);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/**
 * Reads the key from `location.hash`.
 * Returns `null` when absent or malformed — never a default or derived key,
 * because a predictable fallback would silently downgrade the room to
 * server-readable media.
 */
export function readRoomKeyFromUrl(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }

  const key = params.get(FRAGMENT_PARAM);
  if (!key) return null;

  // Validate shape before it reaches the crypto layer: 32 bytes is exactly 43
  // base64url characters without padding.
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) return null;

  try {
    return fromBase64Url(key).byteLength === KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

/** Builds the shareable meeting URL, key included. */
export function buildMeetingUrl(origin: string, roomId: string, key: string): string {
  return `${origin}/r/${roomId}#${FRAGMENT_PARAM}=${key}`;
}

/**
 * Converts the transported key into the raw bytes LiveKit's key provider needs.
 * LiveKit derives the actual content-encryption key via HKDF internally.
 */
export function decodeRoomKey(key: string): ArrayBuffer {
  const bytes = fromBase64Url(key);
  // A fresh, exactly-sized buffer — never a view into a larger allocation,
  // which the key provider would read past.
  return bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Safety number: a short fingerprint of the room key.
 *
 * What it defends against is narrow but real. The server never sees the key, so
 * it cannot tamper with it — but a *link* can be tampered with. Someone sent a
 * convincing lookalike invitation ends up in a different room, with a different
 * key, believing they are in the right meeting. Reading four groups of digits
 * aloud settles that in seconds, over a channel the attacker does not control.
 *
 * It proves the room, not the people: everyone holding the link has the same
 * key, so a matching number says "same meeting", never "no eavesdropper".
 */
export async function safetyNumber(roomKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', decodeRoomKey(roomKey));
  const bytes = new Uint8Array(digest);

  // Four groups of five digits: long enough that a collision cannot be
  // engineered casually, short enough to read over a phone.
  const groups: string[] = [];
  for (let i = 0; i < 4; i++) {
    let value = 0;
    for (let j = 0; j < 3; j++) value = value * 256 + (bytes[i * 3 + j] ?? 0);
    groups.push(String(value % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}

/**
 * Derives the room ID from the key, so the link need not carry both.
 *
 * The key is 43 of the old URL's 88 characters and cannot shrink — 256 bits at
 * six bits per base64url character is exactly 43, and random data does not
 * compress. The room ID, however, is redundant: hashing the key yields a
 * stable identifier every participant computes for themselves, taking the URL
 * from 88 characters to 70.
 *
 * The server still learns only the ID. SHA-256 preimage resistance means an ID
 * reveals nothing about the key that produced it, so this gives away no more
 * than a server-generated ID did — while the key itself never leaves the
 * fragment, and so never reaches the server or a link-preview crawler.
 */
export async function deriveRoomId(roomKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', decodeRoomKey(roomKey));
  const bytes = new Uint8Array(digest);

  // Same alphabet and 4-4-4 shape as a generated ID, so the server's existing
  // validation and every display path continue to work untouched.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 12; i++) out += alphabet[(bytes[i] ?? 0) % alphabet.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

/** Short shareable link: the key alone, in the fragment. */
export function buildShortMeetingUrl(origin: string, key: string): string {
  return `${origin}/#${key}`;
}

/**
 * Reads a key from either link form.
 *
 * The short form is a bare fragment; the original `#k=<key>` is still accepted
 * so links already pasted into calendars and chats keep working.
 */
export function readRoomKeyFromAnyUrl(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;

  // Bare fragment: the whole thing is the key.
  if (/^[A-Za-z0-9_-]{43}$/.test(raw)) return readRoomKeyFromUrl(`#k=${raw}`);

  return readRoomKeyFromUrl(hash);
}
