/**
 * Country lookup for connecting addresses.
 *
 * ── What this does and does not retain ───────────────────────────────────────
 *
 * An address goes in and a two-letter country code comes out. The address is
 * not stored, not logged, and not returned; the only thing that survives the
 * call is `+1` against a counter for a country, in a rolling 24-hour window
 * shared by everyone who connected from that country.
 *
 * That is the distinction that keeps this inside what the privacy policy already
 * says. "Someone in Germany joined a meeting in the last hour" is not a record
 * of who connected — it cannot be narrowed to a person, a meeting, or an
 * address, and it does not become more revealing as it accumulates. A list of
 * addresses with countries attached would be exactly the durable record this
 * design avoids everywhere else, which is why the lookup returns a code and the
 * caller is given no way to ask "which addresses were these".
 *
 * Countries are worth having because they are the shape of an attack: ordinary
 * traffic follows the places the people using the service live, and a hundred
 * refused joins from somewhere that has never appeared before is a fact an
 * operator can act on.
 *
 * ── Off by default ───────────────────────────────────────────────────────────
 *
 * There is no bundled database and no network call — the lookup is a local file
 * or nothing. Unset `GEOIP_DB` and this module answers `null` to everything, the
 * dashboard says so plainly, and no geolocation happens anywhere in the process.
 */
import { readFile } from 'node:fs/promises';
import { MmdbReader, type MmdbValue } from './mmdb.js';

export type GeoipState = 'off' | 'ready' | 'error';

export interface GeoipStatus {
  state: GeoipState;
  /** e.g. `DBIP-Country-Lite` or `GeoLite2-Country`. */
  database: string | null;
  /** When the database was built. Country data goes stale within months. */
  builtAt: number | null;
  /** Present only when loading failed; safe to show an operator. */
  error: string | null;
}

let reader: MmdbReader | null = null;
let status: GeoipStatus = { state: 'off', database: null, builtAt: null, error: null };

/**
 * Repeat lookups are free.
 *
 * Bounded and dropped wholesale when full rather than evicted one at a time: an
 * exact LRU would buy nothing here, and a cache that cannot be grown past a
 * fixed size is a cache an attacker cannot use as a memory amplifier. Holds
 * addresses only for as long as traffic keeps them there — it is a lookup
 * cache, not a record, and it never leaves the process.
 */
const CACHE_LIMIT = 4096;
const cache = new Map<string, string | null>();

/**
 * Loads the database, once, at boot.
 *
 * A missing or unreadable file is not fatal. This is an operational
 * convenience: the server must still start and take meetings without it.
 */
export async function initGeoip(
  path: string,
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void },
): Promise<void> {
  if (!path) {
    status = { state: 'off', database: null, builtAt: null, error: null };
    return;
  }

  try {
    const buffer = await readFile(path);
    const loaded = new MmdbReader(buffer);

    reader = loaded;
    status = {
      state: 'ready',
      database: loaded.metadata.databaseType,
      builtAt: loaded.metadata.buildEpoch * 1000,
      error: null,
    };

    log.info(
      { database: loaded.metadata.databaseType, built: new Date(status.builtAt ?? 0).toISOString() },
      'country database loaded',
    );
  } catch (error) {
    reader = null;
    status = {
      state: 'error',
      database: null,
      builtAt: null,
      // The message names a path the operator supplied, which is theirs to see.
      error: error instanceof Error ? error.message : 'could not read the database',
    };
    log.warn({ err: error, path }, 'country database could not be loaded; continuing without it');
  }
}

/**
 * The ISO 3166-1 alpha-2 code for an address, or `null`.
 *
 * `null` covers every uninteresting case identically — no database, a private
 * or loopback address, an unparseable one, or a public address the database has
 * no entry for. The caller counts those as "unknown" rather than distinguishing
 * them, because the distinction is not actionable.
 */
export function lookupCountry(ip: string): string | null {
  if (!reader) return null;

  const cached = cache.get(ip);
  if (cached !== undefined) return cached;

  const record = reader.lookup(ip);
  const code = extractCountry(record);

  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(ip, code);

  return code;
}

function extractCountry(record: MmdbValue): string | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;

  const map = record as Record<string, MmdbValue>;
  // `country` is where a client's location lives; `registered_country` is the
  // owner of the allocation and is the only thing present for some ranges.
  for (const key of ['country', 'registered_country'] as const) {
    const entry = map[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;

    const code = (entry as Record<string, MmdbValue>).iso_code;
    // Validated rather than trusted: this string becomes a map key on a
    // counter, and the file it came from is not ours.
    if (typeof code === 'string' && /^[A-Z]{2}$/.test(code)) return code;
  }

  return null;
}

export function geoipStatus(): GeoipStatus {
  return { ...status };
}

/** Test seam: drops the loaded database and the cache. */
export function resetGeoip(): void {
  reader = null;
  cache.clear();
  status = { state: 'off', database: null, builtAt: null, error: null };
}
