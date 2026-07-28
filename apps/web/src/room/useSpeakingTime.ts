/**
 * Speaking-time balance.
 *
 * Every participant already receives `ActiveSpeakersChanged`; until now it was
 * used only to draw a ring and then discarded. Accumulating it costs nothing
 * and surfaces the thing every work meeting has and no tool shows: that three
 * people spoke for forty minutes and four said nothing.
 *
 * Computed locally from events everyone receives, so no data crosses the wire
 * and there is nothing for the server to learn or store. Each client's totals
 * are its own view; they agree closely because the events are broadcast, but
 * this is a conversational cue rather than an audit trail.
 */
import { useEffect, useRef, useState } from 'react';
import { RoomEvent, type Participant, type Room } from 'livekit-client';

export interface SpeakingShare {
  identity: string;
  name: string;
  /** Milliseconds spent as an active speaker. */
  totalMs: number;
  /** Share of all speaking time, 0-1. */
  share: number;
}

/** Recomputed on this cadence rather than per event, to avoid churning renders. */
const REFRESH_MS = 4_000;

export function useSpeakingTime(room: Room | null, enabled: boolean): SpeakingShare[] {
  const [shares, setShares] = useState<SpeakingShare[]>([]);
  // Totals live in a ref so accumulating them never triggers a render; only the
  // periodic snapshot below does.
  const totals = useRef(new Map<string, { name: string; ms: number }>());
  const activeSince = useRef(new Map<string, number>());

  useEffect(() => {
    if (!room || !enabled) return;

    const onSpeakersChanged = (speakers: Participant[]) => {
      const now = performance.now();
      const active = new Set(speakers.map((speaker) => speaker.identity));

      // Anyone who stopped: bank the interval they were speaking for.
      for (const [identity, since] of activeSince.current) {
        if (!active.has(identity)) {
          const entry = totals.current.get(identity);
          if (entry) entry.ms += now - since;
          activeSince.current.delete(identity);
        }
      }

      // Anyone who started: note when, and keep their name current.
      for (const speaker of speakers) {
        totals.current.set(speaker.identity, {
          name: speaker.name || 'Guest',
          ms: totals.current.get(speaker.identity)?.ms ?? 0,
        });
        if (!activeSince.current.has(speaker.identity)) {
          activeSince.current.set(speaker.identity, now);
        }
      }
    };

    const snapshot = () => {
      const now = performance.now();
      const merged = new Map<string, { name: string; ms: number }>();

      for (const [identity, entry] of totals.current) {
        merged.set(identity, { ...entry });
      }
      // Include the in-progress interval so a long monologue is visible while
      // it is still happening, not only once it ends.
      for (const [identity, since] of activeSince.current) {
        const entry = merged.get(identity);
        if (entry) entry.ms += now - since;
      }

      const total = [...merged.values()].reduce((sum, entry) => sum + entry.ms, 0);
      setShares(
        [...merged.entries()]
          .map(([identity, entry]) => ({
            identity,
            name: entry.name,
            totalMs: Math.round(entry.ms),
            share: total > 0 ? entry.ms / total : 0,
          }))
          .sort((a, b) => b.totalMs - a.totalMs),
      );
    };

    room.on(RoomEvent.ActiveSpeakersChanged, onSpeakersChanged);
    const timer = window.setInterval(snapshot, REFRESH_MS);

    return () => {
      room.off(RoomEvent.ActiveSpeakersChanged, onSpeakersChanged);
      window.clearInterval(timer);
    };
  }, [room, enabled]);

  return shares;
}
