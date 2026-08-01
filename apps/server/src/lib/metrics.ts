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
 * No IP addresses. They already appear in request logs for rate limiting, which
 * the policy discloses; surfacing them in a dashboard would turn a rotating log
 * into a browsable record of who connected.
 *
 * No display names. They are filtered out of logs and have no business here.
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

interface HourBucket {
  /** Epoch hour this bucket represents; identifies a stale slot for reuse. */
  hour: number;
  roomsCreated: number;
  tokensIssued: number;
  joinsRejected: number;
  peakParticipants: number;
}

function emptyBucket(hour: number): HourBucket {
  return { hour, roomsCreated: 0, tokensIssued: 0, joinsRejected: 0, peakParticipants: 0 };
}

const buckets: HourBucket[] = [];

/** Cumulative since boot. Cheap, and useful for spotting a step change. */
const totals = {
  roomsCreated: 0,
  tokensIssued: 0,
  joinsRejected: 0,
  /** Keyed by reason. A spike in one of these is the abuse signal. */
  rejectionsByReason: new Map<string, number>(),
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
export function recordJoinRejected(reason: string): void {
  totals.joinsRejected += 1;
  totals.rejectionsByReason.set(reason, (totals.rejectionsByReason.get(reason) ?? 0) + 1);
  bucketFor(currentHour()).joinsRejected += 1;
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

export interface MetricsSnapshot {
  uptimeSeconds: number;
  memoryMb: number;
  totals: {
    roomsCreated: number;
    tokensIssued: number;
    joinsRejected: number;
    rejectionsByReason: Record<string, number>;
  };
  lastDay: {
    roomsCreated: number;
    tokensIssued: number;
    joinsRejected: number;
    peakParticipants: number;
  };
  hourly: { hour: number; roomsCreated: number; tokensIssued: number; peakParticipants: number }[];
  meetingLength: {
    completed: number;
    averageMinutes: number;
    /** Labelled buckets, e.g. "≤5m", "≤15m", "over 120m". */
    histogram: { label: string; count: number }[];
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

  return {
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    totals: {
      roomsCreated: totals.roomsCreated,
      tokensIssued: totals.tokensIssued,
      joinsRejected: totals.joinsRejected,
      rejectionsByReason: Object.fromEntries(totals.rejectionsByReason),
    },
    lastDay: {
      roomsCreated: window.reduce((sum, b) => sum + b.roomsCreated, 0),
      tokensIssued: window.reduce((sum, b) => sum + b.tokensIssued, 0),
      joinsRejected: window.reduce((sum, b) => sum + b.joinsRejected, 0),
      peakParticipants: window.reduce((peak, b) => Math.max(peak, b.peakParticipants), 0),
    },
    hourly: window
      .slice()
      .sort((a, b) => a.hour - b.hour)
      .map(({ hour: h, roomsCreated, tokensIssued, peakParticipants }) => ({
        hour: h,
        roomsCreated,
        tokensIssued,
        peakParticipants,
      })),
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
