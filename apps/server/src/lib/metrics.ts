/**
 * Operational counters.
 *
 * These exist to answer two questions: is the server being overused, and is it
 * being attacked. Nothing here is designed to answer "what happened in meeting
 * X", and the shape of the data is what enforces that rather than a policy
 * about how it gets read.
 *
 * ── What is deliberately absent, and why ─────────────────────────────────────
 *
 * No per-meeting rows. The privacy policy says rooms are held in memory and
 * discarded shortly after the meeting ends, and that there is no database. A
 * table of past meetings would be a durable record of who met when, which is
 * precisely the thing the product claims not to keep.
 *
 * No room identifiers, anywhere. This is the subtle one. A room id is a *hash
 * of the encryption key*, so anyone holding a meeting link can compute it. If
 * ids were retained alongside timestamps, a person with an old link could
 * establish that a specific meeting happened, when, for how long, and how many
 * people attended. Aggregate counters cannot be queried that way by anyone,
 * including the operator.
 *
 * No IP addresses for anyone who simply used the service. A record of who
 * connected is exactly what this design avoids everywhere else.
 *
 * Addresses that generate *rejections* are the one exception, and the
 * distinction is the whole argument: this is a list of sources that were
 * refused, not a list of people who joined meetings. The policy already says an
 * address is "recorded in operational logs used for rate limiting and abuse
 * handling", and an operator cannot block what they cannot see. The list is
 * bounded, holds only addresses at or above a threshold of refusals, and ages
 * out with the rest of the window.
 *
 * No display names. They are filtered out of logs and have no business here.
 *
 * Countries are counted, addresses are not. An address is turned into a
 * two-letter code and discarded within the same function call, and what remains
 * is a tally shared by everyone who connected from that country in the same
 * hour. "Four people joined from Germany" cannot be narrowed to a person, a
 * meeting, or an address, and it does not become more revealing as it
 * accumulates — which is exactly why the counter is per country rather than per
 * anything smaller. See lib/geoip.ts, which is off unless a database is
 * configured.
 *
 * ── Retention ────────────────────────────────────────────────────────────────
 *
 * In memory, and lost on restart. Nothing is written to disk, which keeps the
 * "there is no database" claim literally true. Daily figures are derived from a
 * rolling 24-hour ring of hourly buckets, so the oldest data ages out on its own
 * rather than accumulating.
 */

/** Hours retained. One day of hourly buckets, then the oldest is overwritten. */
const WINDOW_HOURS = 24;

/** Distinct countries held per hour. There are about 250 in the world. */
const COUNTRY_LIMIT = 300;

interface HourBucket {
  /** Epoch hour this bucket represents; identifies a stale slot for reuse. */
  hour: number;
  roomsCreated: number;
  tokensIssued: number;
  joinsRejected: number;
  peakParticipants: number;
  /** Participants LiveKit reported as actually connected. */
  participantsConnected: number;
  /** Media bytes forwarded by the SFU during this hour; see lib/sfu.ts. */
  bytesIn: number;
  bytesOut: number;
  /**
   * Counts per country code, and `ZZ` for anything that could not be resolved.
   * Never an address — see the note on countries above.
   */
  countries: Map<string, { joined: number; refused: number }>;
}

function emptyBucket(hour: number): HourBucket {
  return {
    hour,
    roomsCreated: 0,
    tokensIssued: 0,
    joinsRejected: 0,
    peakParticipants: 0,
    participantsConnected: 0,
    bytesIn: 0,
    bytesOut: 0,
    countries: new Map(),
  };
}

const buckets: HourBucket[] = [];

/** Cumulative since boot. Cheap, and useful for spotting a step change. */
const totals = {
  roomsCreated: 0,
  tokensIssued: 0,
  joinsRejected: 0,
  /** Keyed by reason. A spike in one of these is the abuse signal. */
  rejectionsByReason: new Map<string, number>(),
  /**
   * Tokens that turned into a participant LiveKit actually saw.
   *
   * The gap between this and `tokensIssued` is the one failure this service
   * cannot otherwise observe: everything on the control plane succeeded, and
   * then the media connection did not establish. It is invisible in every other
   * counter here, because from this process's point of view the join worked.
   */
  participantsConnected: 0,
  /** Token replays caught by the webhook receiver and evicted. */
  replayEvictions: 0,
  /** Webhook deliveries by event name. A fixed set chosen by LiveKit. */
  webhookEvents: new Map<string, number>(),
};

/**
 * Completed meeting durations, as counts per bucket rather than a list.
 *
 * A histogram cannot be reversed into individual meetings, which is the whole
 * reason for using one — a list of durations plus a timestamp would be a
 * meeting log wearing a different hat.
 */
const DURATION_BUCKETS_MINUTES = [1, 5, 15, 30, 60, 120] as const;
const durations = {
  counts: new Array<number>(DURATION_BUCKETS_MINUTES.length + 1).fill(0),
  completed: 0,
  totalMinutes: 0,
};

/**
 * Sources that have been refused, so an operator can act on them.
 *
 * Bounded and rolling. Only an address that has been rejected at least
 * OFFENDER_THRESHOLD times is ever surfaced, which keeps a single fat-fingered
 * meeting code from putting somebody on a list.
 */
const OFFENDER_THRESHOLD = 5;
const OFFENDER_LIMIT = 100;
const OFFENDER_TTL_MS = 6 * 3_600_000;

interface Offender {
  count: number;
  firstAt: number;
  lastAt: number;
  reasons: Map<string, number>;
}

const offenders = new Map<string, Offender>();

function pruneOffenders(now: number): void {
  for (const [ip, entry] of offenders) {
    if (now - entry.lastAt > OFFENDER_TTL_MS) offenders.delete(ip);
  }

  if (offenders.size <= OFFENDER_LIMIT) return;

  // Keep the worst. An attacker cannot evict a real offender by flooding from
  // many addresses, because eviction is by count rather than by recency.
  const ranked = [...offenders.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [ip] of ranked.slice(OFFENDER_LIMIT)) offenders.delete(ip);
}

function currentHour(): number {
  return Math.floor(Date.now() / 3_600_000);
}

function bucketFor(hour: number): HourBucket {
  const existing = buckets.find((bucket) => bucket.hour === hour);
  if (existing) return existing;

  const fresh = emptyBucket(hour);
  buckets.push(fresh);

  // Drop anything outside the window. Bounded by construction, so a
  // long-running process cannot grow this without limit.
  const oldest = hour - WINDOW_HOURS;
  for (let i = buckets.length - 1; i >= 0; i--) {
    if ((buckets[i]?.hour ?? 0) <= oldest) buckets.splice(i, 1);
  }

  return fresh;
}

export function recordRoomCreated(): void {
  totals.roomsCreated += 1;
  bucketFor(currentHour()).roomsCreated += 1;
}

export function recordTokenIssued(): void {
  totals.tokensIssued += 1;
  bucketFor(currentHour()).tokensIssued += 1;
}

/**
 * A join that was refused. `reason` must be a fixed label chosen by the caller,
 * never anything derived from user input — an unbounded key set would both leak
 * request content into memory and let a caller grow the map at will.
 */
export function recordJoinRejected(reason: string, ip?: string): void {
  totals.joinsRejected += 1;
  totals.rejectionsByReason.set(reason, (totals.rejectionsByReason.get(reason) ?? 0) + 1);
  bucketFor(currentHour()).joinsRejected += 1;

  if (!ip) return;

  const now = Date.now();
  const entry = offenders.get(ip) ?? { count: 0, firstAt: now, lastAt: now, reasons: new Map() };
  entry.count += 1;
  entry.lastAt = now;
  entry.reasons.set(reason, (entry.reasons.get(reason) ?? 0) + 1);
  offenders.set(ip, entry);

  pruneOffenders(now);
}

export interface OffenderSummary {
  ip: string;
  count: number;
  firstAt: number;
  lastAt: number;
  reasons: Record<string, number>;
}

/** Sources at or above the threshold, worst first. */
export function listOffenders(): OffenderSummary[] {
  pruneOffenders(Date.now());
  return [...offenders.entries()]
    .filter(([, entry]) => entry.count >= OFFENDER_THRESHOLD)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([ip, entry]) => ({
      ip,
      count: entry.count,
      firstAt: entry.firstAt,
      lastAt: entry.lastAt,
      reasons: Object.fromEntries(entry.reasons),
    }));
}

/** Called with a live count so the hourly peak can be tracked. */
export function recordParticipantCount(count: number): void {
  const bucket = bucketFor(currentHour());
  if (count > bucket.peakParticipants) bucket.peakParticipants = count;
}

/** A meeting ended. Only its length is kept, and only as a bucket tally. */
export function recordMeetingDuration(minutes: number): void {
  if (!Number.isFinite(minutes) || minutes < 0) return;

  durations.completed += 1;
  durations.totalMinutes += minutes;

  const index = DURATION_BUCKETS_MINUTES.findIndex((edge) => minutes <= edge);
  const slot = index === -1 ? DURATION_BUCKETS_MINUTES.length : index;
  durations.counts[slot] = (durations.counts[slot] ?? 0) + 1;
}

/**
 * Which countries connected, as counts.
 *
 * `code` is a two-letter country or `null` when it could not be resolved —
 * geolocation switched off, a private address, or a range the database has no
 * entry for. Unresolved is counted as `ZZ` rather than dropped, so the totals
 * still add up and a dashboard cannot imply more precision than there is.
 */
export function recordCountry(code: string | null, outcome: 'joined' | 'refused'): void {
  const bucket = bucketFor(currentHour());
  // Validated because the value originates in a database file this code did not
  // write, and it becomes a map key.
  const key = code && /^[A-Z]{2}$/.test(code) ? code : 'ZZ';

  const entry = bucket.countries.get(key);
  if (entry) {
    entry[outcome] += 1;
    return;
  }

  // Bounded, though reaching the limit would mean more countries than exist.
  if (bucket.countries.size >= COUNTRY_LIMIT) return;
  bucket.countries.set(key, { joined: outcome === 'joined' ? 1 : 0, refused: outcome === 'refused' ? 1 : 0 });
}

/** Media bytes the SFU forwarded since the previous scrape. See lib/sfu.ts. */
export function recordBandwidth(bytesIn: number, bytesOut: number): void {
  if (!Number.isFinite(bytesIn) || !Number.isFinite(bytesOut)) return;

  const bucket = bucketFor(currentHour());
  bucket.bytesIn += Math.max(0, bytesIn);
  bucket.bytesOut += Math.max(0, bytesOut);
}

/** A participant LiveKit reported as connected. The other half of the funnel. */
export function recordParticipantConnected(): void {
  totals.participantsConnected += 1;
  bucketFor(currentHour()).participantsConnected += 1;
}

export function recordReplayEviction(): void {
  totals.replayEvictions += 1;
}

/** `event` is LiveKit's event name, which is a fixed vocabulary. */
export function recordWebhookEvent(event: string): void {
  // Capped anyway: the name arrives in a signed payload, but a future LiveKit
  // version inventing events must not grow this without limit.
  if (totals.webhookEvents.size >= 32 && !totals.webhookEvents.has(event)) return;
  totals.webhookEvents.set(event, (totals.webhookEvents.get(event) ?? 0) + 1);
}

/**
 * ── HTTP timings ─────────────────────────────────────────────────────────────
 *
 * A ten-minute rolling window rather than a total since restart, because this is
 * the panel someone reads *during* an incident: a p95 averaged over three days
 * of uptime cannot show that the last few minutes are bad. One slot per minute,
 * reused as the window turns.
 *
 * Latencies are counted into fixed buckets rather than kept as a list. A list of
 * request durations is unbounded, and percentiles from buckets are accurate to
 * within a bucket width, which is far finer than any decision made from them.
 */
const HTTP_WINDOW_MINUTES = 10;

/** Upper edges in milliseconds. The last bucket catches everything above. */
const LATENCY_EDGES = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const;

interface RouteStats {
  count: number;
  totalMs: number;
  /** One more slot than there are edges: the overflow. */
  buckets: number[];
  /** Keyed by `2xx`, `4xx`, and so on. */
  statusClasses: Map<string, number>;
}

interface MinuteSlot {
  minute: number;
  routes: Map<string, RouteStats>;
}

/** Bounded: the route table is fixed, and `other` catches anything unexpected. */
const ROUTE_LIMIT = 64;

const httpSlots: MinuteSlot[] = [];

function emptyRoute(): RouteStats {
  return {
    count: 0,
    totalMs: 0,
    buckets: new Array<number>(LATENCY_EDGES.length + 1).fill(0),
    statusClasses: new Map(),
  };
}

function slotFor(minute: number): MinuteSlot {
  const existing = httpSlots.find((slot) => slot.minute === minute);
  if (existing) return existing;

  const fresh: MinuteSlot = { minute, routes: new Map() };
  httpSlots.push(fresh);

  const oldest = minute - HTTP_WINDOW_MINUTES;
  for (let i = httpSlots.length - 1; i >= 0; i--) {
    if ((httpSlots[i]?.minute ?? 0) <= oldest) httpSlots.splice(i, 1);
  }

  return fresh;
}

/**
 * One completed response.
 *
 * `route` must be the matched route *pattern* (`/api/rooms/:roomId/join`), never
 * the request URL. A raw URL carries the room id, which is a hash of the
 * encryption key and must never be retained — and it would also make the key set
 * unbounded, which is the other half of why this takes a pattern.
 */
export function recordHttpResponse(route: string, statusCode: number, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;

  const slot = slotFor(Math.floor(Date.now() / 60_000));

  let stats = slot.routes.get(route);
  if (!stats) {
    const key = slot.routes.size >= ROUTE_LIMIT ? 'other' : route;
    stats = slot.routes.get(key) ?? emptyRoute();
    slot.routes.set(key, stats);
  }

  stats.count += 1;
  stats.totalMs += durationMs;

  const index = LATENCY_EDGES.findIndex((edge) => durationMs <= edge);
  const bucket = index === -1 ? LATENCY_EDGES.length : index;
  stats.buckets[bucket] = (stats.buckets[bucket] ?? 0) + 1;

  const statusClass = `${Math.floor(statusCode / 100)}xx`;
  stats.statusClasses.set(statusClass, (stats.statusClasses.get(statusClass) ?? 0) + 1);
}

/**
 * Percentile from bucket counts, interpolated within the bucket it lands in.
 *
 * A value in the overflow bucket is reported as the top edge — the data says
 * only "above 5000ms", and inventing a number beyond it would be a guess
 * presented as a measurement.
 */
export function percentileFrom(buckets: readonly number[], quantile: number): number {
  const total = buckets.reduce((sum, count) => sum + count, 0);
  if (total === 0) return 0;

  const target = total * quantile;
  let cumulative = 0;

  for (let i = 0; i < buckets.length; i++) {
    const count = buckets[i] ?? 0;
    cumulative += count;
    if (cumulative < target || count === 0) continue;

    const lower = i === 0 ? 0 : (LATENCY_EDGES[i - 1] ?? 0);
    const upper = LATENCY_EDGES[i];
    if (upper === undefined) return LATENCY_EDGES[LATENCY_EDGES.length - 1] ?? 0;

    const within = (count - (cumulative - target)) / count;
    return Math.round((lower + (upper - lower) * within) * 10) / 10;
  }

  return LATENCY_EDGES[LATENCY_EDGES.length - 1] ?? 0;
}

export interface RouteSummary {
  route: string;
  count: number;
  perMinute: number;
  averageMs: number;
  p50: number;
  p95: number;
  p99: number;
  statusClasses: Record<string, number>;
}

function httpSummary(): {
  windowMinutes: number;
  requests: number;
  requestsPerMinute: number;
  statusClasses: Record<string, number>;
  routes: RouteSummary[];
} {
  const minute = Math.floor(Date.now() / 60_000);
  const window = httpSlots.filter((slot) => slot.minute > minute - HTTP_WINDOW_MINUTES);

  const merged = new Map<string, RouteStats>();
  for (const slot of window) {
    for (const [route, stats] of slot.routes) {
      const target = merged.get(route) ?? emptyRoute();
      target.count += stats.count;
      target.totalMs += stats.totalMs;
      stats.buckets.forEach((count, index) => {
        target.buckets[index] = (target.buckets[index] ?? 0) + count;
      });
      for (const [statusClass, count] of stats.statusClasses) {
        target.statusClasses.set(statusClass, (target.statusClasses.get(statusClass) ?? 0) + count);
      }
      merged.set(route, target);
    }
  }

  const statusClasses: Record<string, number> = {};
  let requests = 0;

  const routes = [...merged.entries()]
    .map(([route, stats]) => {
      requests += stats.count;
      for (const [statusClass, count] of stats.statusClasses) {
        statusClasses[statusClass] = (statusClasses[statusClass] ?? 0) + count;
      }

      return {
        route,
        count: stats.count,
        perMinute: Math.round((stats.count / HTTP_WINDOW_MINUTES) * 10) / 10,
        averageMs: stats.count === 0 ? 0 : Math.round((stats.totalMs / stats.count) * 10) / 10,
        p50: percentileFrom(stats.buckets, 0.5),
        p95: percentileFrom(stats.buckets, 0.95),
        p99: percentileFrom(stats.buckets, 0.99),
        statusClasses: Object.fromEntries(stats.statusClasses),
      };
    })
    .sort((a, b) => b.count - a.count);

  return {
    windowMinutes: HTTP_WINDOW_MINUTES,
    requests,
    requestsPerMinute: Math.round((requests / HTTP_WINDOW_MINUTES) * 10) / 10,
    statusClasses,
    routes,
  };
}

/**
 * Event-loop lag, sampled continuously.
 *
 * The single most useful health signal for a Node service: memory can look fine
 * and CPU can look idle while the loop is blocked and every request is queued
 * behind something synchronous. Measured by comparing a timer's actual delay
 * against its requested one.
 */
const LAG_INTERVAL_MS = 1000;
let lagMs = 0;
let lastTick = Date.now();

const lagTimer = setInterval(() => {
  const now = Date.now();
  lagMs = Math.max(0, now - lastTick - LAG_INTERVAL_MS);
  lastTick = now;
}, LAG_INTERVAL_MS);
// Never hold the process open for a metrics timer.
lagTimer.unref();

let lastCpu = process.cpuUsage();
let lastCpuAt = Date.now();

/** Percent of one core since the previous call. Stateful by necessity. */
function cpuPercent(): number {
  const now = Date.now();
  const usage = process.cpuUsage(lastCpu);
  const elapsedMs = now - lastCpuAt;

  lastCpu = process.cpuUsage();
  lastCpuAt = now;

  if (elapsedMs <= 0) return 0;
  const usedMs = (usage.user + usage.system) / 1000;
  return Math.round((usedMs / elapsedMs) * 1000) / 10;
}

export interface CountrySummary {
  /** ISO 3166-1 alpha-2, or `ZZ` for addresses that could not be resolved. */
  code: string;
  joined: number;
  refused: number;
}

export interface MetricsSnapshot {
  uptimeSeconds: number;
  memoryMb: number;
  cpuPercent: number;
  eventLoopLagMs: number;
  totals: {
    roomsCreated: number;
    tokensIssued: number;
    joinsRejected: number;
    rejectionsByReason: Record<string, number>;
    participantsConnected: number;
    replayEvictions: number;
    webhookEvents: Record<string, number>;
  };
  lastDay: {
    roomsCreated: number;
    tokensIssued: number;
    joinsRejected: number;
    peakParticipants: number;
    participantsConnected: number;
  };
  hourly: {
    hour: number;
    roomsCreated: number;
    tokensIssued: number;
    peakParticipants: number;
    bytesIn: number;
    bytesOut: number;
  }[];
  meetingLength: {
    completed: number;
    averageMinutes: number;
    /** Labelled buckets, e.g. "≤5m", "≤15m", "over 120m". */
    histogram: { label: string; count: number }[];
  };
  /** Media bytes forwarded by the SFU, over the same rolling day. */
  bandwidth: {
    bytesIn: number;
    bytesOut: number;
    /** Sum of both directions, which is what a provider bills for. */
    bytesTotal: number;
  };
  /** Counts per country over the rolling day. Never addresses. */
  countries: CountrySummary[];
  /**
   * Joins that completed versus joins that were authorised. A widening gap is
   * media failing to establish after the control plane has done its part.
   */
  funnel: {
    tokensIssued: number;
    participantsConnected: number;
    /** Percent, or `null` before any token has been issued today. */
    connectRate: number | null;
  };
  http: {
    windowMinutes: number;
    requests: number;
    requestsPerMinute: number;
    statusClasses: Record<string, number>;
    routes: RouteSummary[];
  };
}

export function snapshot(): MetricsSnapshot {
  const hour = currentHour();
  const window = buckets.filter((bucket) => bucket.hour > hour - WINDOW_HOURS);

  const histogram = DURATION_BUCKETS_MINUTES.map((edge, index) => ({
    label: `≤${edge}m`,
    count: durations.counts[index] ?? 0,
  }));
  histogram.push({
    label: `over ${DURATION_BUCKETS_MINUTES[DURATION_BUCKETS_MINUTES.length - 1]}m`,
    count: durations.counts[DURATION_BUCKETS_MINUTES.length] ?? 0,
  });

  const countries = new Map<string, { joined: number; refused: number }>();
  for (const bucket of window) {
    for (const [code, counts] of bucket.countries) {
      const entry = countries.get(code) ?? { joined: 0, refused: 0 };
      entry.joined += counts.joined;
      entry.refused += counts.refused;
      countries.set(code, entry);
    }
  }

  const tokensIssuedToday = window.reduce((sum, b) => sum + b.tokensIssued, 0);
  const connectedToday = window.reduce((sum, b) => sum + b.participantsConnected, 0);
  const bytesIn = window.reduce((sum, b) => sum + b.bytesIn, 0);
  const bytesOut = window.reduce((sum, b) => sum + b.bytesOut, 0);

  return {
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    cpuPercent: cpuPercent(),
    eventLoopLagMs: lagMs,
    totals: {
      roomsCreated: totals.roomsCreated,
      tokensIssued: totals.tokensIssued,
      joinsRejected: totals.joinsRejected,
      rejectionsByReason: Object.fromEntries(totals.rejectionsByReason),
      participantsConnected: totals.participantsConnected,
      replayEvictions: totals.replayEvictions,
      webhookEvents: Object.fromEntries(totals.webhookEvents),
    },
    lastDay: {
      roomsCreated: window.reduce((sum, b) => sum + b.roomsCreated, 0),
      tokensIssued: tokensIssuedToday,
      joinsRejected: window.reduce((sum, b) => sum + b.joinsRejected, 0),
      peakParticipants: window.reduce((peak, b) => Math.max(peak, b.peakParticipants), 0),
      participantsConnected: connectedToday,
    },
    hourly: window
      .slice()
      .sort((a, b) => a.hour - b.hour)
      .map(({ hour: h, roomsCreated, tokensIssued, peakParticipants, bytesIn: hourIn, bytesOut: hourOut }) => ({
        hour: h,
        roomsCreated,
        tokensIssued,
        peakParticipants,
        bytesIn: hourIn,
        bytesOut: hourOut,
      })),
    bandwidth: { bytesIn, bytesOut, bytesTotal: bytesIn + bytesOut },
    countries: [...countries.entries()]
      .map(([code, counts]) => ({ code, ...counts }))
      .sort((a, b) => b.joined + b.refused - (a.joined + a.refused)),
    funnel: {
      tokensIssued: tokensIssuedToday,
      participantsConnected: connectedToday,
      connectRate:
        tokensIssuedToday === 0
          ? null
          : Math.round((connectedToday / tokensIssuedToday) * 1000) / 10,
    },
    http: httpSummary(),
    meetingLength: {
      completed: durations.completed,
      averageMinutes:
        durations.completed === 0
          ? 0
          : Math.round((durations.totalMinutes / durations.completed) * 10) / 10,
      histogram,
    },
  };
}
