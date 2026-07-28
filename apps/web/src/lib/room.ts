/**
 * Room ID parsing and normalisation.
 *
 * Mirrors the server's alphabet so an obvious typo is caught before a round
 * trip. The server remains the authority — this is a UX affordance, not a
 * security check.
 */

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const ROOM_ID_PATTERN = new RegExp(`^[${ALPHABET}]{4}-[${ALPHABET}]{4}-[${ALPHABET}]{4}$`);

export function isValidRoomId(value: string): boolean {
  return ROOM_ID_PATTERN.test(value);
}

/**
 * Placeholder base for relative inputs. Only the path and fragment are ever
 * read, so the host is irrelevant — and a reserved `.invalid` TLD can never
 * resolve. Using this instead of `window.location.origin` keeps the parser pure
 * and free of any DOM dependency.
 */
const URL_BASE = 'https://meeting.invalid';

/**
 * Accepts what people actually paste: a bare ID, an ID typed without hyphens,
 * or a full meeting URL. Returns the canonical ID plus any embedded key.
 *
 * The host in a pasted link is deliberately ignored — a meeting is always
 * joined on the origin the user is already on, so a link pointing at another
 * deployment cannot redirect them somewhere unexpected.
 */
export function parseMeetingInput(input: string): { roomId: string; key: string | null } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Full or partial URL.
  if (trimmed.includes('/')) {
    try {
      const url = new URL(trimmed, URL_BASE);
      const match = /\/r\/([^/?#]+)/.exec(url.pathname);
      if (!match?.[1]) return null;
      const roomId = canonicalise(decodeURIComponent(match[1]));
      if (!roomId) return null;
      const key = new URLSearchParams(url.hash.replace(/^#/, '')).get('k');
      return { roomId, key };
    } catch {
      return null;
    }
  }

  const roomId = canonicalise(trimmed);
  return roomId ? { roomId, key: null } : null;
}

/** Lowercases and re-inserts hyphens so `K7DE2MQX9HBT` resolves correctly. */
function canonicalise(value: string): string | null {
  const compact = value.toLowerCase().replace(/[\s-]/g, '');
  if (compact.length !== 12) return null;
  const formatted = `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}`;
  return isValidRoomId(formatted) ? formatted : null;
}
