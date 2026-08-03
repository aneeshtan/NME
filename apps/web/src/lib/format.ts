/**
 * Display formatting for the health dashboard.
 *
 * Separate from the page because these carry decisions rather than syntax —
 * which unit a figure is quoted in, and what a missing value looks like — and
 * because a formatter that silently rounds the wrong way is the kind of bug
 * that survives a visual check.
 */

/**
 * Bytes in the units a host bills in — powers of 1000, not 1024.
 *
 * A provider quoting "2 TB of transfer" means 2,000,000,000,000 bytes. Showing
 * GiB against that would put the dashboard in disagreement with the invoice by
 * about 10%, in the direction that looks reassuring.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];

  // One decimal below 100, none above: "1.2 GB" is useful precision and
  // "847.3 GB" is noise.
  const round = (value: number): number =>
    value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;

  let value = bytes;
  let unit = 0;

  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }

  /**
   * Rounding can cross the boundary the loop above just decided not to.
   * 999,999,999,999 bytes is 999.999… GB — under the threshold, so the loop
   * stops — and rounds to 1000, which would print as "1000 GB" rather than
   * "1 TB". Stepping up once more is enough: the result is then below 1.
   */
  let shown = round(value);
  if (shown >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
    shown = round(value);
  }

  return `${shown} ${units[unit]}`;
}

export function formatMb(megabytes: number): string {
  return megabytes >= 1024 ? `${Math.round((megabytes / 1024) * 10) / 10} GB` : `${megabytes} MB`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

export function formatHour(hour: number): string {
  return new Date(hour * 3_600_000).toLocaleTimeString([], { hour: '2-digit' });
}

/** An em dash for absent, which is never the same thing as zero. */
export function formatPercent(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${value}%`;
}

export function formatMs(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${value} ms`;
}

/** `{audio: 3, video: 0}` as `audio 3`. Empty when there is nothing to say. */
export function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${key} ${count}`)
    .join(' · ');
}

/**
 * How long ago, from a server timestamp.
 *
 * Clamped at zero: this compares the browser's clock against the server's, and
 * a few seconds of skew would otherwise render as "-3s ago".
 */
export function formatAgo(at: number | null, now = Date.now()): string {
  if (!at) return 'never';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  return seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
}

/**
 * A country's name, falling back to its code.
 *
 * `Intl.DisplayNames` is in every browser this app supports and saves shipping
 * a table of 250 names that would then need maintaining.
 */
const regionNames =
  typeof Intl !== 'undefined' && 'DisplayNames' in Intl
    ? new Intl.DisplayNames(['en'], { type: 'region' })
    : null;

export function countryName(code: string): string {
  // The server's marker for an address it could not resolve. Named rather than
  // shown raw, so nobody reads it as a country they have not heard of.
  if (code === 'ZZ') return 'Unresolved';

  try {
    return regionNames?.of(code) ?? code;
  } catch {
    // `of()` throws on anything that is not a well-formed region code.
    return code;
  }
}
