/**
 * Turning an incoming link into a room key.
 *
 * The native clients receive links from places the web client never does: a
 * Universal Link tap, an `nme://` custom-scheme URL, a paste from a chat app
 * that has helpfully mangled it. All of them have to end at the same 32 bytes,
 * or the user joins a meeting nobody else is in.
 *
 * The host is read and discarded, exactly as the web client does with a pasted
 * link. A meeting is always joined against the deployment the app was built
 * for. If the host were honoured, a forged invitation could point the app at a
 * server the attacker runs; the media would still be encrypted to a key that
 * server never sees, but the *admission* decision would be theirs, and they
 * could put the user in a room with whoever they liked.
 */
import { readRoomKeyFromAnyUrl } from './e2ee';

/**
 * Extracts the room key from any link form the app can be handed.
 * Returns `null` for anything malformed — never a fallback key.
 */
export function readRoomKeyFromLink(link: string): string | null {
  const trimmed = link.trim();
  if (!trimmed) return null;

  // A bare key, which is what a user pasting from a password manager or a
  // "copy link" that lost its prefix will produce.
  if (/^[A-Za-z0-9_-]{43}$/.test(trimmed)) return readRoomKeyFromAnyUrl(`#${trimmed}`);

  // Everything else is located by its fragment. Parsing with `URL` would mean
  // handling `nme://meet#k=…`, where the authority is a scheme-specific host
  // rather than a real one, plus every browser quirk around custom schemes —
  // when the only part that matters is what follows the first `#`.
  const hash = trimmed.indexOf('#');
  if (hash === -1) return null;

  return readRoomKeyFromAnyUrl(trimmed.slice(hash));
}
