/**
 * Health dashboard.
 *
 * Shows nothing about any individual meeting, because the server holds nothing
 * about any individual meeting — no room identifiers and no participant names
 * exist to display. That is a property of what is collected, not of what this
 * page chooses to render.
 *
 * Addresses do appear, in one place: sources that have been *refused*. Blocking
 * is impossible without them, the privacy policy already says addresses are used
 * for abuse handling, and the distinction that keeps this honest is that it is a
 * list of who was turned away rather than a list of who joined a meeting.
 *
 * Countries appear as counts per country over a rolling day. That cannot be
 * narrowed to a person, a meeting, or an address, it does not become more
 * revealing as it accumulates, and it is switched off entirely unless the
 * operator supplies a geolocation database.
 *
 * The token is held in sessionStorage rather than localStorage, so closing the
 * tab discards it. An operator credential that survives on a shared machine
 * indefinitely is a worse risk than retyping it.
 */
import { useCallback, useEffect, useState } from 'react';
import { PageLayout, Section } from '../components/PageLayout';
import {
  countryName,
  formatAgo,
  formatBytes,
  formatCounts,
  formatDuration,
  formatHour,
  formatMb,
  formatMs,
  formatPercent,
} from '../lib/format';

const TOKEN_KEY = 'nme.adminToken';

interface Offender {
  ip: string;
  count: number;
  firstAt: number;
  lastAt: number;
  reasons: Record<string, number>;
}

interface Blocked {
  ip: string;
  expiresAt: number;
}

interface RouteSummary {
  route: string;
  count: number;
  perMinute: number;
  averageMs: number;
  p50: number;
  p95: number;
  p99: number;
  statusClasses: Record<string, number>;
}

/** LiveKit's own counters. Media never reaches this server; see lib/sfu.ts. */
interface Sfu {
  reachable: boolean;
  scrapedAt: number | null;
  error: string | null;
  hasCounters: boolean;
  throughput: { inMbps: number; outMbps: number; windowSeconds: number };
  transferred: { bytesIn: number; bytesOut: number; sinceMs: number };
  quality: {
    packetLossPercent: number | null;
    retransmitPercent: number | null;
    nacksPerMinute: number;
    plisPerMinute: number;
    rttMs: number | null;
    jitterMs: number | null;
  };
  live: {
    rooms: number;
    participants: number;
    tracksPublished: Record<string, number>;
    tracksSubscribed: Record<string, number>;
    connections: Record<string, number>;
    joins: Record<string, number>;
  };
}

interface SystemStats {
  process: {
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
    externalMb: number;
    nodeVersion: string;
  };
  container: {
    memoryLimitMb: number | null;
    memoryUsedMb: number | null;
    memoryPercent: number | null;
    cpuLimit: number | null;
  };
  host: {
    load: [number, number, number];
    cores: number;
    loadPerCore: number;
    memoryTotalMb: number;
    memoryFreeMb: number;
    uptimeSeconds: number;
  };
}

/**
 * Everything added since the first version of this page is optional, so a
 * browser left open across a deploy renders what it has instead of throwing on
 * a field the older server did not send.
 */
interface Stats {
  active: { rooms: number; participants: number };
  offenders: Offender[];
  blocked: Blocked[];
  uptimeSeconds: number;
  memoryMb: number;
  cpuPercent: number;
  eventLoopLagMs: number;
  sfu?: Sfu;
  system?: SystemStats;
  store?: { backend: string; ok: boolean; latencyMs: number | null; error: string | null };
  geoip?: {
    state: 'off' | 'ready' | 'error';
    database: string | null;
    builtAt: number | null;
    error: string | null;
  };
  totals: {
    roomsCreated: number;
    tokensIssued: number;
    joinsRejected: number;
    rejectionsByReason: Record<string, number>;
    participantsConnected?: number;
    replayEvictions?: number;
    webhookEvents?: Record<string, number>;
  };
  lastDay: {
    roomsCreated: number;
    tokensIssued: number;
    joinsRejected: number;
    peakParticipants: number;
    participantsConnected?: number;
  };
  hourly: {
    hour: number;
    roomsCreated: number;
    tokensIssued: number;
    peakParticipants: number;
    bytesIn?: number;
    bytesOut?: number;
  }[];
  bandwidth?: { bytesIn: number; bytesOut: number; bytesTotal: number };
  countries?: { code: string; joined: number; refused: number }[];
  funnel?: { tokensIssued: number; participantsConnected: number; connectRate: number | null };
  http?: {
    windowMinutes: number;
    requests: number;
    requestsPerMinute: number;
    statusClasses: Record<string, number>;
    routes: RouteSummary[];
  };
  meetingLength: {
    completed: number;
    averageMinutes: number;
    histogram: { label: string; count: number }[];
  };
}

export default function Health() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? '');
  const [draft, setDraft] = useState('');
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (bearer: string) => {
    try {
      const response = await fetch('/api/admin/stats', {
        headers: { Authorization: `Bearer ${bearer}` },
      });

      if (!response.ok) {
        // The server answers 404 for both "disabled" and "wrong token" on
        // purpose, so this message has to cover both without guessing.
        setError('Not available. Check the token, and that ADMIN_TOKEN is set on the server.');
        setStats(null);
        return;
      }

      setStats((await response.json()) as Stats);
      setError(null);
    } catch {
      setError('Could not reach the server.');
    }
  }, []);

  const setBlock = useCallback(
    async (ip: string, unblock: boolean) => {
      setBusy(ip);
      try {
        const response = await fetch('/api/admin/block', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ip, unblock, hours: 24 }),
        });
        if (!response.ok) {
          setError('That did not take. Check the token and try again.');
          return;
        }
        await load(token);
      } finally {
        setBusy(null);
      }
    },
    [token, load],
  );

  useEffect(() => {
    if (!token) return;
    void load(token);
    // Ten seconds is frequent enough to watch an incident and slow enough to
    // be invisible against ordinary traffic.
    const timer = window.setInterval(() => void load(token), 10_000);
    return () => window.clearInterval(timer);
  }, [token, load]);

  if (!token) {
    return (
      <PageLayout title="Health">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = draft.trim();
            if (!trimmed) return;
            sessionStorage.setItem(TOKEN_KEY, trimmed);
            setToken(trimmed);
          }}
          className="max-w-sm"
        >
          <label htmlFor="adminToken" className="block text-sm font-medium">
            Admin token
          </label>
          <input
            id="adminToken"
            type="password"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            autoComplete="off"
            className="mt-2 w-full rounded-xl border border-border bg-elevated px-4 py-3 text-base outline-none focus:border-accent"
          />
          <button
            type="submit"
            className="mt-4 w-full rounded-xl bg-accent px-5 py-3 text-base font-semibold text-white hover:bg-accent-hover"
          >
            Open dashboard
          </button>
          <p className="mt-4 text-[0.8125rem] leading-relaxed text-muted">
            Set <code className="rounded bg-elevated px-1 py-px">ADMIN_TOKEN</code> in the
            server environment. While it is unset the endpoint does not exist.
          </p>
        </form>
      </PageLayout>
    );
  }

  return (
    <PageLayout
      title="Health"
      intro={
        <>
          Load, capacity, and abuse signals. Nothing here identifies a meeting, a room, or a
          person — none of that is collected.
        </>
      }
    >
      {error && (
        <p role="alert" className="rounded-xl border border-danger px-4 py-3 text-sm text-danger">
          {error}
        </p>
      )}

      {stats && (
        <>
          <Section title="Right now">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Meetings" value={stats.active.rooms} />
              <Stat label="Participants" value={stats.active.participants} />
              <Stat
                label="Media in"
                value={stats.sfu?.reachable ? `${stats.sfu.throughput.inMbps} Mb/s` : '—'}
              />
              <Stat
                label="Media out"
                value={stats.sfu?.reachable ? `${stats.sfu.throughput.outMbps} Mb/s` : '—'}
              />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Event loop lag" value={`${stats.eventLoopLagMs} ms`} />
              <Stat label="CPU" value={`${stats.cpuPercent}%`} />
              <Stat label="Memory" value={`${stats.memoryMb} MB`} />
              <Stat label="Uptime" value={formatDuration(stats.uptimeSeconds)} />
            </div>
            <p>
              Event loop lag is the one to watch on this process. Memory and CPU can both look
              fine while the loop is blocked and every request is queued behind something
              synchronous — sustained lag above roughly 100&nbsp;ms means this process is the
              bottleneck. The media figures are the SFU&rsquo;s rather than this server&rsquo;s,
              because media never passes through here.
            </p>
          </Section>

          <Section title="Bandwidth">
            {stats.sfu && !stats.sfu.reachable ? (
              <Unavailable
                what="The SFU metrics endpoint"
                detail={stats.sfu.error}
                hint="LiveKit exposes these on :6789 inside the compose network — check prometheus_port in infra/livekit.yaml."
              />
            ) : stats.sfu && !stats.sfu.hasCounters ? (
              // Reached LiveKit, but it exposed no byte counters. Distinct from
              // zero traffic, and worth saying so: a version that renamed these
              // series would otherwise render as a confident "0 B".
              <Unavailable
                what="Byte counters"
                detail="LiveKit answered, but exposed no livekit_packet_bytes series."
                hint="Most likely a LiveKit version that names them differently. The figures below would read zero rather than unknown, so they are withheld."
              />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat label="Out, last 24h" value={formatBytes(stats.bandwidth?.bytesOut ?? 0)} />
                  <Stat label="In, last 24h" value={formatBytes(stats.bandwidth?.bytesIn ?? 0)} />
                  <Stat label="Total" value={formatBytes(stats.bandwidth?.bytesTotal ?? 0)} />
                  <Stat
                    label="At this rate, a month"
                    value={formatBytes((stats.bandwidth?.bytesTotal ?? 0) * 30)}
                  />
                </div>
                <p>
                  What the SFU forwarded, which is what a host bills for. Outbound is the number
                  that matters: every participant receives a copy of every other
                  participant&rsquo;s streams, so it grows with the square of meeting size while
                  inbound grows linearly. The monthly figure is the last day &times;&nbsp;30 and
                  assumes today was typical — it is an order of magnitude, not a forecast.
                </p>
                <Bars
                  items={stats.hourly.map((bucket) => ({
                    label: formatHour(bucket.hour),
                    value: (bucket.bytesIn ?? 0) + (bucket.bytesOut ?? 0),
                  }))}
                  format={formatBytes}
                />
                <p className="text-[0.8125rem]">
                  Accumulated by this process from LiveKit&rsquo;s cumulative counters, so
                  restarting either resets the history rather than backfilling it.
                </p>
              </>
            )}
          </Section>

          {stats.sfu?.reachable && (
            <Section title="Media quality">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat
                  label="Packet loss"
                  value={formatPercent(stats.sfu.quality.packetLossPercent)}
                />
                <Stat
                  label="Retransmitted"
                  value={formatPercent(stats.sfu.quality.retransmitPercent)}
                />
                <Stat label="Round trip" value={formatMs(stats.sfu.quality.rttMs)} />
                <Stat label="Jitter" value={formatMs(stats.sfu.quality.jitterMs)} />
              </div>
              <p>
                Loss above roughly 2% is where people start describing a call as choppy, and it
                is usually the far end&rsquo;s network rather than this server. What would
                implicate the server is loss climbing at the same time as CPU or the connection
                count — that is the SFU running out of headroom rather than one person on bad
                Wi-Fi.
              </p>
              <Rows
                items={[
                  { label: 'Keyframe requests', value: `${stats.sfu.quality.plisPerMinute} / min` },
                  {
                    label: 'Retransmit requests',
                    value: `${stats.sfu.quality.nacksPerMinute} / min`,
                  },
                  { label: 'Tracks published', value: formatCounts(stats.sfu.live.tracksPublished) },
                  {
                    label: 'Tracks subscribed',
                    value: formatCounts(stats.sfu.live.tracksSubscribed),
                  },
                  { label: 'Connections', value: formatCounts(stats.sfu.live.connections) },
                ]}
              />
              <p className="text-[0.8125rem]">
                Connections are broken down by transport. A rising share on TCP means networks
                are blocking UDP — those calls still work, but head-of-line blocking makes them
                measurably worse, and it is the case the relay fallback exists for.
              </p>
            </Section>
          )}

          <Section title="Joins that connected">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Tokens issued" value={stats.funnel?.tokensIssued ?? 0} />
              <Stat label="Connected" value={stats.funnel?.participantsConnected ?? 0} />
              <Stat label="Connect rate" value={formatPercent(stats.funnel?.connectRate ?? null)} />
              <Stat label="Replays evicted" value={stats.totals.replayEvictions ?? 0} />
            </div>
            <p>
              The one failure this server cannot otherwise see. Everything on the control plane
              can succeed — the token is minted, the room exists — and the media connection
              still never establishes, at which point somebody is looking at a call that will
              not start while every other counter here says the join worked. A connect rate
              durably below about 90% points at ICE: blocked UDP, a NAT nobody can traverse, or
              a relay that is not configured.
            </p>
            <p className="text-[0.8125rem]">
              Slight overshoot is normal rather than a fault — somebody who reconnects after a
              network change joins twice on one token. Last 24 hours; evictions are since
              restart.
            </p>
          </Section>

          <Section title="Where connections come from">
            {!stats.geoip || stats.geoip.state === 'off' ? (
              <Unavailable
                what="Country lookup"
                detail="No database is configured, so no geolocation happens anywhere in this process."
                hint="Set GEOIP_DB to an MMDB country database to switch it on. DB-IP publishes a free one that needs no account — see docs/health-dashboard.md."
              />
            ) : stats.geoip.state === 'error' ? (
              <Unavailable what="The country database" detail={stats.geoip.error} hint={null} />
            ) : (
              <>
                <p>
                  Counts per country over the last 24 hours — never addresses, and never
                  attributable to a person or a meeting. Ordinary traffic follows wherever the
                  people using this server live. A column of refusals from somewhere that has
                  never appeared before is the shape of an attack, and it is the thing worth
                  acting on here.
                </p>
                <CountryTable rows={stats.countries ?? []} />
                <p className="text-[0.8125rem]">
                  {stats.geoip.database}, built{' '}
                  {stats.geoip.builtAt ? new Date(stats.geoip.builtAt).toLocaleDateString() : '—'}.
                  Country data drifts within months, and a stale file gets quietly less accurate
                  rather than failing. <code className="rounded bg-elevated px-1 py-px">ZZ</code>{' '}
                  is anything unresolved: a private address, or a range the database has no entry
                  for.
                </p>
              </>
            )}
          </Section>

          {stats.http && (
            <Section title="API responsiveness">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Requests / min" value={stats.http.requestsPerMinute} />
                <Stat label="Client errors" value={stats.http.statusClasses['4xx'] ?? 0} />
                <Stat label="Server errors" value={stats.http.statusClasses['5xx'] ?? 0} />
                <Stat label="Window" value={`${stats.http.windowMinutes} min`} />
              </div>
              <p>
                A rolling {stats.http.windowMinutes}-minute window, so this shows what is
                happening now rather than an average flattened across days of uptime. Any 5xx is
                worth reading the logs over. A 4xx count climbing on{' '}
                <code className="rounded bg-elevated px-1 py-px">/rooms/:roomId/join</code> is the
                same signal as the rejection counters further down.
              </p>
              <RouteTable rows={stats.http.routes} />
              <p className="text-[0.8125rem]">
                Milliseconds, timed from request to response, so they include the calls this
                server makes to LiveKit and Redis on the way. Join is slower than the rest by
                nature: it asks the SFU for a participant count and mints a token.
              </p>
            </Section>
          )}

          {stats.system && (
            <Section title="Resources">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat
                  label="Container memory"
                  value={
                    stats.system.container.memoryLimitMb
                      ? `${stats.system.container.memoryUsedMb ?? 0} / ${stats.system.container.memoryLimitMb} MB`
                      : `${stats.system.process.rssMb} MB`
                  }
                />
                <Stat label="Heap" value={`${stats.system.process.heapUsedMb} MB`} />
                <Stat label="Host load" value={stats.system.host.load[0]} />
                <Stat label="Cores" value={stats.system.host.cores} />
              </div>
              {stats.system.container.memoryPercent !== null && (
                <Meter
                  label="Toward the container limit"
                  percent={stats.system.container.memoryPercent}
                />
              )}
              <p>
                The container limit is the one that bites. Exceeding it does not degrade
                anything — Docker kills the process outright, and the same is true of the far
                larger limit on the SFU container, where it would drop every meeting on the host
                at once. Both are values in{' '}
                <code className="rounded bg-elevated px-1 py-px">infra/docker-compose.yml</code>,
                not limits of the software.
              </p>
              <Rows
                items={[
                  {
                    label: 'Heap',
                    value: `${stats.system.process.heapUsedMb} of ${stats.system.process.heapTotalMb} MB, RSS ${stats.system.process.rssMb} MB`,
                  },
                  {
                    label: 'CPU allowance',
                    value: stats.system.container.cpuLimit
                      ? `${stats.system.container.cpuLimit} of ${stats.system.host.cores} cores`
                      : `unlimited, ${stats.system.host.cores} cores`,
                  },
                  {
                    label: 'Host load average',
                    value: `${stats.system.host.load.join(' · ')} (${stats.system.host.loadPerCore} per core)`,
                  },
                  {
                    label: 'Host memory free',
                    value: `${formatMb(stats.system.host.memoryFreeMb)} of ${formatMb(stats.system.host.memoryTotalMb)}`,
                  },
                  { label: 'Host uptime', value: formatDuration(stats.system.host.uptimeSeconds) },
                  { label: 'Node', value: `v${stats.system.process.nodeVersion}` },
                ]}
              />
              <p className="text-[0.8125rem]">
                Host figures cover the whole machine, including the SFU. Load per core above 1
                sustained means the box is oversubscribed, and on this stack that is nearly
                always LiveKit rather than anything else on this page.
              </p>
            </Section>
          )}

          <Section title="Dependencies">
            <Rows
              items={[
                {
                  label: 'Shared state',
                  value: stats.store
                    ? stats.store.backend === 'memory'
                      ? 'in-process — single node, blocks hold here only'
                      : stats.store.ok
                        ? `Redis, ${stats.store.latencyMs} ms`
                        : `Redis unreachable — ${stats.store.error ?? 'no detail'}`
                    : '—',
                },
                {
                  label: 'SFU metrics',
                  value: stats.sfu
                    ? stats.sfu.reachable
                      ? `scraped ${formatAgo(stats.sfu.scrapedAt)}`
                      : `unreachable — ${stats.sfu.error ?? 'no detail'}`
                    : '—',
                },
                {
                  label: 'Country database',
                  value:
                    stats.geoip?.state === 'ready'
                      ? (stats.geoip.database ?? 'loaded')
                      : stats.geoip?.state === 'error'
                        ? `failed — ${stats.geoip.error ?? 'no detail'}`
                        : 'off',
                },
                {
                  label: 'Webhook deliveries',
                  value: formatCounts(stats.totals.webhookEvents ?? {}) || 'none yet',
                },
              ]}
            />
            <p>
              Redis unreachable is survivable rather than fatal: the rate limiter fails open, the
              blocklist falls back to this process, and meetings keep working — but a block
              applied on one replica stops holding on the others. Webhook deliveries at zero
              while meetings are running means LiveKit cannot reach this server, which silently
              disables both replay eviction and the connected count above.
            </p>
          </Section>

          <Section title="Sources being refused">
            <p>
              Addresses that have been rejected at least five times in the last six hours.
              Ordinary users generate almost none — they arrive by link — so a climbing count
              here is someone probing. Blocking refuses them outright for 24 hours.
            </p>
            {stats.offenders.length === 0 ? (
              <p className="text-muted">None.</p>
            ) : (
              <ul className="space-y-2">
                {stats.offenders.map((offender) => (
                  <li
                    key={offender.ip}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border px-3 py-2"
                  >
                    <span className="font-mono text-[0.8125rem] text-fg">{offender.ip}</span>
                    <span className="text-xs text-muted">
                      {offender.count} refused · {Object.keys(offender.reasons).join(', ')}
                    </span>
                    <button
                      type="button"
                      disabled={busy === offender.ip}
                      onClick={() => void setBlock(offender.ip, false)}
                      className="ml-auto shrink-0 rounded-md bg-danger px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
                    >
                      Block 24h
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Blocked">
            {stats.blocked.length === 0 ? (
              <p className="text-muted">Nothing blocked.</p>
            ) : (
              <ul className="space-y-2">
                {stats.blocked.map((entry) => (
                  <li
                    key={entry.ip}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border px-3 py-2"
                  >
                    <span className="font-mono text-[0.8125rem] text-fg">{entry.ip}</span>
                    <span className="text-xs text-muted">
                      until {new Date(entry.expiresAt).toLocaleString()}
                    </span>
                    <button
                      type="button"
                      disabled={busy === entry.ip}
                      onClick={() => void setBlock(entry.ip, true)}
                      className="ml-auto shrink-0 rounded-md border border-border px-3 py-1 text-xs font-medium disabled:opacity-50"
                    >
                      Unblock
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p>
              Blocks expire on their own. Addresses are reassigned, and a list that only grows
              would become the durable record this design avoids everywhere else.
            </p>
          </Section>

          <Section title="Last 24 hours">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Meetings created" value={stats.lastDay.roomsCreated} />
              <Stat label="Joins" value={stats.lastDay.tokensIssued} />
              <Stat label="Peak participants" value={stats.lastDay.peakParticipants} />
              <Stat label="Rejected joins" value={stats.lastDay.joinsRejected} />
            </div>
          </Section>

          <Section title="Rejections since restart">
            <p>
              A sustained climb here, especially in one category, is the signal worth acting
              on — it is what a scripted attempt against the server looks like.
            </p>
            {Object.keys(stats.totals.rejectionsByReason).length === 0 ? (
              <p className="text-muted">None.</p>
            ) : (
              <ul className="space-y-1">
                {Object.entries(stats.totals.rejectionsByReason).map(([reason, count]) => (
                  <li key={reason} className="flex justify-between gap-4 tabular-nums">
                    <span className="font-mono text-[0.8125rem]">{reason}</span>
                    <span className="font-medium text-fg">{count}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Meeting length">
            <p>
              {stats.meetingLength.completed} completed since restart, averaging{' '}
              {stats.meetingLength.averageMinutes} minutes. Counts per band only — individual
              durations are not retained.
            </p>
            <Bars
              items={stats.meetingLength.histogram.map((bucket) => ({
                label: bucket.label,
                value: bucket.count,
              }))}
            />
          </Section>

          <Section title="Meetings per hour">
            <Bars
              items={stats.hourly.map((bucket) => ({
                label: formatHour(bucket.hour),
                value: bucket.roomsCreated,
              }))}
            />
          </Section>

          <button
            type="button"
            onClick={() => {
              sessionStorage.removeItem(TOKEN_KEY);
              setToken('');
              setStats(null);
            }}
            className="mt-10 rounded-xl border border-border px-5 py-2.5 text-sm font-medium hover:bg-surface"
          >
            Sign out
          </button>
        </>
      )}
    </PageLayout>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="text-2xl font-semibold tabular-nums text-fg">{value}</div>
      <div className="mt-1 text-xs text-muted">{label}</div>
    </div>
  );
}

/** Label and value on one line. For facts that are read rather than compared. */
function Rows({ items }: { items: { label: string; value: string | number }[] }) {
  return (
    <ul className="space-y-1">
      {items.map((item) => (
        <li key={item.label} className="flex flex-wrap justify-between gap-x-4 gap-y-0.5">
          <span className="text-[0.8125rem]">{item.label}</span>
          <span className="text-[0.8125rem] font-medium tabular-nums text-fg">{item.value}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A panel that has nothing to show, and why.
 *
 * Distinct from a zero on purpose. "Nothing, because this is switched off" and
 * "nothing, because nothing happened" lead to entirely different actions, and a
 * dashboard that renders both as 0 has misled whoever is reading it.
 */
function Unavailable({
  what,
  detail,
  hint,
}: {
  what: string;
  detail: string | null;
  hint: string | null;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="text-[0.9375rem] text-fg">{what} is not available.</p>
      {detail && <p className="mt-1 text-[0.8125rem] text-muted">{detail}</p>}
      {hint && <p className="mt-2 text-[0.8125rem] text-muted">{hint}</p>}
    </div>
  );
}

/** A single proportion, where the proportion is the whole point. */
function Meter({ label, percent }: { label: string; percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  // Red past 85%: close enough to the limit that the next spike is the one that
  // gets the process killed.
  const tone = clamped >= 85 ? 'bg-danger' : 'bg-accent';

  return (
    <div>
      <div className="flex justify-between text-[0.8125rem]">
        <span>{label}</span>
        <span className="font-medium tabular-nums text-fg">{percent}%</span>
      </div>
      <span className="mt-1.5 block h-2 overflow-hidden rounded-full bg-surface">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${clamped}%` }} />
      </span>
    </div>
  );
}

/** Joins and refusals on one bar, because the ratio is the signal. */
function CountryTable({ rows }: { rows: { code: string; joined: number; refused: number }[] }) {
  if (rows.length === 0) return <p className="text-muted">Nothing yet.</p>;

  const max = Math.max(1, ...rows.map((row) => row.joined + row.refused));

  return (
    <div className="space-y-1.5">
      {rows.map((row) => (
        <div key={row.code} className="flex items-center gap-3 text-[0.8125rem]">
          <span className="w-32 shrink-0 truncate" title={countryName(row.code)}>
            {countryName(row.code)}
          </span>
          <span className="flex h-2 flex-1 overflow-hidden rounded-full bg-surface">
            <span
              className="block h-full bg-accent"
              style={{ width: `${(row.joined / max) * 100}%` }}
            />
            <span
              className="block h-full bg-danger"
              style={{ width: `${(row.refused / max) * 100}%` }}
            />
          </span>
          <span className="w-20 shrink-0 text-right tabular-nums">
            <span className="font-medium text-fg">{row.joined}</span>
            {row.refused > 0 && <span className="text-danger"> +{row.refused}</span>}
          </span>
        </div>
      ))}
      <p className="pt-1 text-xs text-muted">Joins in accent, refusals in red.</p>
    </div>
  );
}

function RouteTable({ rows }: { rows: RouteSummary[] }) {
  if (rows.length === 0) return <p className="text-muted">No requests in the window.</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[0.8125rem] tabular-nums">
        <thead className="text-xs text-muted">
          <tr>
            <th className="py-1 pr-3 font-medium">Route</th>
            <th className="py-1 pr-3 text-right font-medium">/min</th>
            <th className="py-1 pr-3 text-right font-medium">p50</th>
            <th className="py-1 pr-3 text-right font-medium">p95</th>
            <th className="py-1 pr-3 text-right font-medium">p99</th>
            <th className="py-1 text-right font-medium">Errors</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const errors = (row.statusClasses['4xx'] ?? 0) + (row.statusClasses['5xx'] ?? 0);
            return (
              <tr key={row.route} className="border-t border-border">
                <td className="py-1.5 pr-3 font-mono text-xs break-all">{row.route}</td>
                <td className="py-1.5 pr-3 text-right">{row.perMinute}</td>
                <td className="py-1.5 pr-3 text-right">{row.p50}</td>
                <td className="py-1.5 pr-3 text-right">{row.p95}</td>
                <td className="py-1.5 pr-3 text-right text-fg">{row.p99}</td>
                <td
                  className={`py-1.5 text-right ${
                    (row.statusClasses['5xx'] ?? 0) > 0 ? 'text-danger' : ''
                  }`}
                >
                  {errors}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Horizontal bars rather than a chart library. Everything here is a small set
 * of non-negative counts, which a div with a width expresses exactly as well as
 * a canvas would and without the dependency.
 */
function Bars({
  items,
  format,
}: {
  items: { label: string; value: number }[];
  format?: (value: number) => string;
}) {
  const max = Math.max(1, ...items.map((item) => item.value));

  if (items.length === 0) return <p className="text-muted">No data yet.</p>;

  return (
    <div className="space-y-1.5">
      {items.map((item, index) => (
        <div key={`${item.label}-${index}`} className="flex items-center gap-3 text-[0.8125rem]">
          <span className="w-20 shrink-0 text-right text-muted tabular-nums">{item.label}</span>
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface">
            <span
              className="block h-full rounded-full bg-accent"
              style={{ width: `${(item.value / max) * 100}%` }}
            />
          </span>
          <span className="w-16 shrink-0 text-right font-medium text-fg tabular-nums">
            {format ? format(item.value) : item.value}
          </span>
        </div>
      ))}
    </div>
  );
}
