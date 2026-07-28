/**
 * Display-name normalisation.
 *
 * A display name is the one piece of attacker-controlled text that every other
 * participant's browser renders. React escapes HTML, so this is not the XSS
 * boundary — it is the *impersonation and UI-spoofing* boundary. The classes
 * stripped below are the ones that let a name lie about what it says:
 *
 *  - Bidi overrides (U+202A–U+202E, U+2066–U+2069) visually reorder text, so a
 *    crafted string can render as somebody else's name.
 *  - Zero-width characters let two distinct participants render identically.
 *  - Control characters corrupt logs and terminal output downstream.
 *  - Unbounded combining marks ("Zalgo") overflow the video tile.
 */

const MAX_LENGTH = 32;

/**
 * C0/C1 controls, soft hyphen, zero-width chars, bidi controls, and BOM.
 * Built from explicit code points so the source file stays plain ASCII —
 * an invisible character inside a regex literal is unreviewable.
 */
const INVISIBLE = new RegExp(
  '[' +
    // U+0009..U+000D (tab, LF, VT, FF, CR) are deliberately NOT in this set.
    // They are real separators: they must fold into a space rather than vanish,
    // otherwise "Alice\tSmith" would silently become "AliceSmith".
    '\\u0000-\\u0008' + // C0 controls below tab
    '\\u000E-\\u001F' + // C0 controls above carriage return
    '\\u007F-\\u009F' + // DEL + C1 controls
    '\\u00AD' + //         soft hyphen
    '\\u061C' + //         Arabic letter mark
    '\\u200B-\\u200F' + // zero-width space .. RTL mark
    '\\u202A-\\u202E' + // bidi embedding/override
    '\\u2060-\\u206F' + // word joiner .. deprecated bidi formatting
    '\\uFEFF' + //         byte-order mark
    '\\uFFF9-\\uFFFB' + // interlinear annotation
    ']',
  'gu',
);
/** Any Unicode whitespace, including exotic spaces used to fake indentation. */
const WHITESPACE = /\s+/gu;
/** Combining marks — capped rather than removed so legitimate accents survive. */
const COMBINING = /\p{M}/gu;

/**
 * Returns a safe display name, or `null` if nothing usable remains.
 * `null` is a rejection signal, not a fallback: the caller decides the policy.
 */
export function normalizeDisplayName(input: unknown): string | null {
  if (typeof input !== 'string') return null;

  // Order matters: strip the truly invisible characters first, then fold the
  // remaining separators. Doing it the other way round would convert U+FEFF —
  // which JavaScript's \s matches — into a visible space rather than removing it.
  const name = input
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(WHITESPACE, ' ')
    .trim();

  if (name.length === 0) return null;

  // More combining marks than base characters is never a real name, and it
  // lets a tile's text overflow into its neighbours.
  const marks = name.match(COMBINING)?.length ?? 0;
  if (marks > name.length / 2) return null;

  // Count by code points so an emoji counts as one character, not two.
  const codePoints = Array.from(name);
  const truncated =
    codePoints.length > MAX_LENGTH ? codePoints.slice(0, MAX_LENGTH).join('').trim() : name;

  return truncated.length > 0 ? truncated : null;
}

export const DISPLAY_NAME_MAX_LENGTH = MAX_LENGTH;
