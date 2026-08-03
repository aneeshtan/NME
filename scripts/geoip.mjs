#!/usr/bin/env node
/**
 * Downloads a country database for the health dashboard.
 *
 * DB-IP publish their lite file under CC BY 4.0 with no account, no licence
 * key, and no signup — which is why it is the default here. MaxMind's GeoLite2
 * is the better-known equivalent and works identically; it just requires an
 * account, so fetching it cannot be a one-line script and is left to whoever
 * wants it.
 *
 * Nothing calls this automatically. Geolocation is off unless an operator
 * chooses it, and a build step that quietly downloaded a geolocation database
 * would make that choice for every deployment.
 *
 *   npm run geoip            → ./data/country.mmdb
 *   npm run geoip -- <path>  → somewhere else
 *
 * The file is a snapshot, not a feed: allocations move between countries, so
 * re-run this every few months. A stale database gets quietly less accurate
 * rather than failing, which is worth knowing before trusting an odd-looking
 * country on the dashboard.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const target = resolve(process.argv[2] ?? 'data/country.mmdb');

/**
 * The current month's file, falling back to the previous one.
 *
 * A new month's file does not exist until DB-IP publish it, which is some way
 * into that month — asking only for the current one would leave this script
 * broken for the first days of every month.
 */
function candidates() {
  const now = new Date();
  const months = [];

  for (let back = 0; back < 3; back++) {
    const when = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const month = `${when.getUTCFullYear()}-${String(when.getUTCMonth() + 1).padStart(2, '0')}`;
    months.push(`https://download.db-ip.com/free/dbip-country-lite-${month}.mmdb.gz`);
  }

  return months;
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) return false;

  // Written to a temporary name and renamed on success, so an interrupted
  // download cannot leave a half-file that the server then tries to parse.
  const temporary = `${destination}.partial`;
  await pipeline(Readable.fromWeb(response.body), createGunzip(), createWriteStream(temporary));
  await rename(temporary, destination);
  return true;
}

await mkdir(dirname(target), { recursive: true });

for (const url of candidates()) {
  process.stdout.write(`Trying ${url}\n`);

  try {
    if (!(await download(url, target))) continue;
  } catch (error) {
    process.stdout.write(`  failed: ${error.message}\n`);
    continue;
  }

  const { size } = await stat(target);
  process.stdout.write(
    [
      `\nWrote ${target} (${Math.round(size / 1024 / 1024)} MB).`,
      '',
      'Point the server at it and restart:',
      `  GEOIP_DB=${target}`,
      '',
      'In Docker, mount it read-only and use the path inside the container —',
      'see docs/health-dashboard.md.',
      '',
      'IP geolocation data contributed by DB-IP.com, CC BY 4.0.',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

process.stderr.write(
  'Could not download a database. The dashboard works without one; the country panel stays off.\n',
);
process.exit(1);
