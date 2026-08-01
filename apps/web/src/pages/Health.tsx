/**
 * Health dashboard.
 *
 * Deliberately shows nothing about any individual meeting, because the server
 * holds nothing about any individual meeting — see apps/server/src/lib/metrics.ts.
 * There are no room identifiers, no IP addresses, and no names here, and the
 * reason is not discretion in the UI: those things are never collected.
 *
 * The token is held in sessionStorage rather than localStorage, so closing the
 * tab discards it. An operator credential that survives on a shared machine
 * indefinitely is a worse risk than retyping it.
 */
import { useCallback, useEffect, useState } from 'react';
import { PageLayout, Section } from '../components/PageLayout';

const TOKEN_KEY = 'nme.adminToken';

interface Stats {
  active: { rooms: number; participants: number };
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
    histogram: { label: string; count: number }[];
  };
}

export default function Health() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? '');
  const [draft, setDraft] = useState('');
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          Load and abuse signals. Nothing here identifies a meeting, a room, or a person —
          none of that is collected.
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
              <Stat label="Memory" value={`${stats.memoryMb} MB`} />
              <Stat label="Uptime" value={formatDuration(stats.uptimeSeconds)} />
            </div>
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
                label: new Date(bucket.hour * 3_600_000).toLocaleTimeString([], {
                  hour: '2-digit',
                }),
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

/**
 * Horizontal bars rather than a chart library. Everything here is a small set
 * of non-negative counts, which a div with a width expresses exactly as well as
 * a canvas would and without the dependency.
 */
function Bars({ items }: { items: { label: string; value: number }[] }) {
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
          <span className="w-10 shrink-0 text-right font-medium text-fg tabular-nums">
            {item.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}
