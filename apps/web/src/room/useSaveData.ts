/**
 * Whether the user has asked their device to use less data.
 *
 * Two signals, because no single one is widely supported. `prefers-reduced-data`
 * is the standards-track media query and is the only one Safari will ever
 * implement; `navigator.connection` is the older Network Information API, absent
 * from Safari entirely but present across Chrome and Android — which is exactly
 * the population most likely to be on a metered plan. Either counts.
 *
 * A very slow effective connection is treated as the same request. Someone on
 * 2G has not ticked a box, but sending them a megabit of video is no more use
 * to them than it is affordable.
 *
 * Read once at join rather than watched. Flipping a meeting into audio-only
 * mid-sentence because a phone briefly dropped to 3G would be worse than
 * leaving the decision where the user can see it.
 */

interface NetworkInformation {
  saveData?: boolean;
  effectiveType?: string;
}

function networkInformation(): NetworkInformation | undefined {
  return (navigator as Navigator & { connection?: NetworkInformation }).connection;
}

export function prefersReducedData(): boolean {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    // Wrapped: an unsupported feature makes the query invalid rather than false
    // in some engines, and an exception here would take the whole join with it.
    try {
      if (window.matchMedia('(prefers-reduced-data: reduce)').matches) return true;
    } catch {
      // Unsupported query — fall through to the Network Information API.
    }
  }

  const connection = networkInformation();
  if (!connection) return false;
  if (connection.saveData === true) return true;

  return connection.effectiveType === '2g' || connection.effectiveType === 'slow-2g';
}
