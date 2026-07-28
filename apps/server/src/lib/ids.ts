/**
 * Identifier generation.
 *
 * Every value here is unguessable-by-design: a meeting ID is the only thing
 * standing between a stranger and the participant list, so it is generated from
 * the OS CSPRNG with uniform sampling — never Math.random, never a timestamp,
 * never an incrementing counter.
 */
import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Lowercase alphanumerics minus the visually ambiguous set (0/O, 1/l/I).
 * 31 symbols — small enough to read aloud over a phone call, large enough that
 * 12 characters carry ~59.5 bits of entropy.
 */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const ROOM_ID_LENGTH = 12;

/**
 * Largest multiple of the alphabet size that fits in a byte. Bytes at or above
 * this bound are discarded rather than folded with `%`, which would otherwise
 * make the first few symbols measurably more likely (modulo bias).
 */
const REJECTION_BOUND = Math.floor(256 / ALPHABET.length) * ALPHABET.length;

function randomSymbols(length: number): string {
  let out = '';
  while (out.length < length) {
    // Over-sample so the common case needs a single syscall.
    const bytes = randomBytes((length - out.length) * 2);
    for (const byte of bytes) {
      if (byte >= REJECTION_BOUND) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** Canonical room ID, e.g. `k7de-2mqx-9hbt`. Hyphens are cosmetic. */
export function createRoomId(): string {
  const raw = randomSymbols(ROOM_ID_LENGTH);
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

const ROOM_ID_PATTERN = new RegExp(`^[${ALPHABET}]{4}-[${ALPHABET}]{4}-[${ALPHABET}]{4}$`);

/** Strict shape check. Runs before any value reaches LiveKit's room namespace. */
export function isValidRoomId(value: unknown): value is string {
  return typeof value === 'string' && ROOM_ID_PATTERN.test(value);
}

/**
 * Per-join participant identity.
 *
 * Deliberately random and unrelated to the display name. LiveKit treats
 * identity as a unique key — reusing one silently disconnects the previous
 * holder, so a predictable identity would let anyone with the room ID evict
 * a specific participant at will.
 */
export function createParticipantId(): string {
  return `p_${randomBytes(12).toString('base64url')}`;
}

/** Token identifier, recorded so a replayed token can be detected and burned. */
export function createTokenId(): string {
  return randomUUID();
}
