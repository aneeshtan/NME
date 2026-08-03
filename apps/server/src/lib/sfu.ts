/**
 * SFU media statistics, scraped from LiveKit's Prometheus endpoint.
 *
 * ── Why this is where bandwidth comes from ───────────────────────────────────
 *
 * Media never passes through this process. A participant's audio and video go
 * straight to LiveKit's UDP port, so the control plane's own network counters
 * describe a few kilobytes of JSON and say nothing at all about what the host is
 * actually shifting. LiveKit already counts every byte it forwards, and
 * `prometheus_port: 6789` in infra/livekit.yaml exposes those counters on the
 * compose network, unreachable from outside it.
 *
 * Scraped on a timer rather than when the dashboard is open, for two reasons:
 * Prometheus counters are cumulative, so a rate needs two readings a known
 * interval apart, and the hourly bandwidth history has to accumulate whether or
 * not anyone is watching.
 *
 * ── What it discloses ────────────────────────────────────────────────────────
 *
 * Totals across the whole server. No room, participant, or track identifier
 * appears in these series, so there is nothing here to attribute to a meeting
 * even in principle — the same property the rest of the metrics have, arrived at
 * because LiveKit's node-level counters are aggregates to begin with.
 *
 * Unreachable is a normal state, not an error: LiveKit may be restarting, or the
 * metrics port may be turned off. The panel says so and everything else keeps
 * working.
 */
import { recordBandwidth } from './metrics.js';

export interface PromSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/**
 * Parses the Prometheus text exposition format.
 *
 * Deliberately small: comments are skipped, timestamps ignored, and anything
 * unparseable is dropped rather than throwing. This reads a sibling container's
 * debug endpoint, and a malformed line there must not take a dashboard down.
 */
export function parsePrometheusText(text: string): PromSample[] {
  const samples: PromSample[] = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const braceAt = trimmed.indexOf('{');
    let name: string;
    let labelText = '';
    let rest: string;

    if (braceAt === -1) {
      const space = trimmed.indexOf(' ');
      if (space === -1) continue;
      name = trimmed.slice(0, space);
      rest = trimmed.slice(space + 1);
    } else {
      const closeAt = trimmed.lastIndexOf('}');
      if (closeAt < braceAt) continue;
      name = trimmed.slice(0, braceAt);
      labelText = trimmed.slice(braceAt + 1, closeAt);
      rest = trimmed.slice(closeAt + 1);
    }

    // A sample is `value [timestamp]`; the timestamp is of no use here.
    const value = Number.parseFloat(rest.trim().split(/\s+/)[0] ?? '');
    if (!Number.isFinite(value)) continue;

    samples.push({ name, labels: parseLabels(labelText), value });
  }

  return samples;
}

function parseLabels(text: string): Record<string, string> {
  const labels: Record<string, string> = {};
  // Values are quoted and may contain commas and escaped quotes, so this walks
  // the string rather than splitting on `,`.
  const pattern = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

  for (const match of text.matchAll(pattern)) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) {
      labels[key] = value.replace(/\\(.)/g, '$1');
    }
  }

  return labels;
}

/** Sums every series with this name, optionally filtered by its labels. */
function sum(
  samples: PromSample[],
  name: string,
  where?: (labels: Record<string, string>) => boolean,
): number {
  let total = 0;
  for (const sample of samples) {
    if (sample.name !== name) continue;
    if (where && !where(sample.labels)) continue;
    total += sample.value;
  }
  return total;
}

/** Mean of a histogram, from the `_sum` and `_count` series Prometheus emits. */
function histogramMean(samples: PromSample[], name: string): number | null {
  const count = sum(samples, `${name}_count`);
  if (count <= 0) return null;
  return sum(samples, `${name}_sum`) / count;
}

/** Every distinct value of one label, with its summed total. */
function byLabel(samples: PromSample[], name: string, label: string): Record<string, number> {
  const grouped: Record<string, number> = {};
  for (const sample of samples) {
    if (sample.name !== name) continue;
    const key = sample.labels[label] ?? 'unknown';
    grouped[key] = (grouped[key] ?? 0) + sample.value;
  }
  return grouped;
}

/**
 * The counters read on each scrape.
 *
 * Held so the next scrape can turn cumulative counters into rates. LiveKit
 * restarting resets them all to zero, which shows up as a negative delta and is
 * treated as "start again from here" rather than as a huge negative rate.
 */
interface Counters {
  bytesIn: number;
  bytesOut: number;
  packetsIn: number;
  packetsOut: number;
  retransmitBytes: number;
  packetsLost: number;
  nacks: number;
  plis: number;
}

interface Live {
  rooms: number;
  participants: number;
  tracksPublished: Record<string, number>;
  tracksSubscribed: Record<string, number>;
  connections: Record<string, number>;
  joins: Record<string, number>;
}

export interface SfuSnapshot {
  /** `false` until a scrape succeeds, and again after one fails. */
  reachable: boolean;
  /** Epoch ms of the last successful scrape. */
  scrapedAt: number | null;
  /** Why the last scrape failed, for an operator to act on. */
  error: string | null;
  /** `false` when LiveKit answered but exposed no byte counters. */
  hasCounters: boolean;
  throughput: {
    inMbps: number;
    outMbps: number;
    /** Seconds the rates above were measured over. */
    windowSeconds: number;
  };
  /** Accumulated by this process, so it resets when the control plane does. */
  transferred: { bytesIn: number; bytesOut: number; sinceMs: number };
  quality: {
    /** Share of inbound packets LiveKit saw as lost, over the last window. */
    packetLossPercent: number | null;
    /** Share of outbound bytes that were retransmissions. */
    retransmitPercent: number | null;
    nacksPerMinute: number;
    plisPerMinute: number;
    rttMs: number | null;
    jitterMs: number | null;
  };
  live: Live;
}

const EMPTY_LIVE: Live = {
  rooms: 0,
  participants: 0,
  tracksPublished: {},
  tracksSubscribed: {},
  connections: {},
  joins: {},
};

let previous: { counters: Counters; at: number } | null = null;
let live: Live = EMPTY_LIVE;
let latest: SfuSnapshot = {
  reachable: false,
  scrapedAt: null,
  error: null,
  hasCounters: false,
  throughput: { inMbps: 0, outMbps: 0, windowSeconds: 0 },
  transferred: { bytesIn: 0, bytesOut: 0, sinceMs: Date.now() },
  quality: {
    packetLossPercent: null,
    retransmitPercent: null,
    nacksPerMinute: 0,
    plisPerMinute: 0,
    rttMs: null,
    jitterMs: null,
  },
  live: EMPTY_LIVE,
};

/** Cumulative bytes since this process started, independent of LiveKit's own. */
const transferred = { bytesIn: 0, bytesOut: 0, sinceMs: Date.now() };

function read(samples: PromSample[]): Counters {
  const direction = (value: string) => (labels: Record<string, string>) =>
    labels.direction === value;

  return {
    bytesIn: sum(samples, 'livekit_packet_bytes', direction('incoming')),
    bytesOut: sum(samples, 'livekit_packet_bytes', direction('outgoing')),
    packetsIn: sum(samples, 'livekit_packet_total', direction('incoming')),
    packetsOut: sum(samples, 'livekit_packet_total', direction('outgoing')),
    retransmitBytes: sum(
      samples,
      'livekit_packet_bytes',
      (labels) => labels.direction === 'outgoing' && labels.transmission === 'retransmit',
    ),
    packetsLost: sum(samples, 'livekit_packet_loss_total'),
    nacks: sum(samples, 'livekit_nack_total'),
    plis: sum(samples, 'livekit_pli_total'),
  };
}

/**
 * Difference between two counter readings.
 *
 * A negative result means LiveKit restarted and its counters went back to zero.
 * The honest answer for that window is "unknown", and zero is closer to it than
 * a delta measured against a counter that no longer exists.
 */
function delta(now: number, before: number): number {
  return now >= before ? now - before : 0;
}

export function sfuSnapshot(): SfuSnapshot {
  return latest;
}

/**
 * One scrape. Exported for the tests and for the boot-time first reading;
 * the timer below is what drives it in production.
 */
export async function scrapeSfu(url: string, timeoutMs = 3_000): Promise<SfuSnapshot> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`metrics endpoint answered ${response.status}`);

    apply(parsePrometheusText(await response.text()), Date.now());
  } catch (error) {
    previous = null; // A gap of unknown length must not become a rate.
    latest = {
      ...latest,
      reachable: false,
      error: error instanceof Error ? error.message : 'unreachable',
      throughput: { inMbps: 0, outMbps: 0, windowSeconds: 0 },
      live: EMPTY_LIVE,
    };
  }

  return latest;
}

function apply(samples: PromSample[], now: number): void {
  const counters = read(samples);
  const hasCounters = samples.some((sample) => sample.name === 'livekit_packet_bytes');

  live = {
    rooms: sum(samples, 'livekit_room_total'),
    participants: sum(samples, 'livekit_participant_total'),
    tracksPublished: byLabel(samples, 'livekit_track_published_total', 'kind'),
    tracksSubscribed: byLabel(samples, 'livekit_track_subscribed_total', 'kind'),
    connections: byLabel(samples, 'livekit_connection_total', 'kind'),
    joins: byLabel(samples, 'livekit_participant_join_total', 'state'),
  };

  const elapsedSeconds = previous ? (now - previous.at) / 1000 : 0;
  let throughput = { inMbps: 0, outMbps: 0, windowSeconds: 0 };
  let quality = latest.quality;

  if (previous) {
    const bytesIn = delta(counters.bytesIn, previous.counters.bytesIn);
    const bytesOut = delta(counters.bytesOut, previous.counters.bytesOut);
    const packetsIn = delta(counters.packetsIn, previous.counters.packetsIn);
    const lost = delta(counters.packetsLost, previous.counters.packetsLost);
    const retransmit = delta(counters.retransmitBytes, previous.counters.retransmitBytes);

    // Accumulated regardless of how long the gap was. Bytes that crossed the
    // wire crossed it, and dropping them because two scrapes landed close
    // together would make the hourly history quietly under-report.
    transferred.bytesIn += bytesIn;
    transferred.bytesOut += bytesOut;
    recordBandwidth(bytesIn, bytesOut);

    /**
     * Rates, unlike totals, need a window worth dividing by. Under a second the
     * previous reading is kept instead: a few bytes over a 20ms gap extrapolates
     * to a throughput figure that is arithmetically correct and wildly wrong as
     * a description of the server.
     */
    if (elapsedSeconds >= 1) {
      throughput = {
        // Megabits, because that is the unit a host's network capacity and a
        // provider's bill are both quoted in.
        inMbps: round((bytesIn * 8) / elapsedSeconds / 1e6, 2),
        outMbps: round((bytesOut * 8) / elapsedSeconds / 1e6, 2),
        windowSeconds: Math.round(elapsedSeconds),
      };

      quality = {
        packetLossPercent:
          packetsIn + lost > 0 ? round((lost / (packetsIn + lost)) * 100, 2) : null,
        retransmitPercent: bytesOut > 0 ? round((retransmit / bytesOut) * 100, 2) : null,
        nacksPerMinute: round(
          (delta(counters.nacks, previous.counters.nacks) / elapsedSeconds) * 60,
          1,
        ),
        plisPerMinute: round(
          (delta(counters.plis, previous.counters.plis) / elapsedSeconds) * 60,
          1,
        ),
        rttMs: roundOrNull(histogramMean(samples, 'livekit_rtt_ms'), 1),
        // Reported in microseconds; milliseconds is the unit everything else in
        // this dashboard uses.
        jitterMs: roundOrNull(scale(histogramMean(samples, 'livekit_jitter_us'), 1 / 1000), 2),
      };
    } else {
      throughput = latest.throughput;
    }
  }

  previous = { counters, at: now };
  latest = {
    reachable: true,
    scrapedAt: now,
    error: null,
    hasCounters,
    throughput,
    transferred: { ...transferred },
    quality,
    live,
  };
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function roundOrNull(value: number | null, places: number): number | null {
  return value === null ? null : round(value, places);
}

function scale(value: number | null, factor: number): number | null {
  return value === null ? null : value * factor;
}

/**
 * Starts the scrape loop. Returns a function that stops it.
 *
 * Fifteen seconds is short enough that the "right now" throughput reflects what
 * is happening and long enough that a single meeting's burst does not dominate
 * the reading.
 */
export function startSfuPolling(
  url: string,
  log: { warn: (obj: object, msg: string) => void },
  intervalMs = 15_000,
): () => void {
  if (!url) return () => undefined;

  let warned = false;

  const tick = async (): Promise<void> => {
    const snapshot = await scrapeSfu(url);
    // Logged once per outage rather than every fifteen seconds, which would
    // bury everything else in the log while LiveKit restarts.
    if (!snapshot.reachable && !warned) {
      warned = true;
      log.warn({ url, err: snapshot.error }, 'SFU metrics unreachable');
    } else if (snapshot.reachable) {
      warned = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  // Never hold the process open for a metrics timer.
  timer.unref();

  return () => clearInterval(timer);
}

/** Test seam: forgets the previous reading and the accumulated totals. */
export function resetSfu(): void {
  previous = null;
  live = EMPTY_LIVE;
  transferred.bytesIn = 0;
  transferred.bytesOut = 0;
  transferred.sinceMs = Date.now();
}
