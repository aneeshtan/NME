/**
 * The in-meeting side of the lobby: who is waiting, and letting them in.
 *
 * Everyone in the call polls and everyone can admit, which is what people
 * expect from a meeting and what avoids the single-host failure mode — a
 * meeting whose creator never arrives is otherwise one nobody can be let into.
 * The server keeps this honest by checking the caller is actually connected,
 * so the right to admit appears on joining and disappears on leaving.
 */
import { useCallback, useEffect, useState } from 'react';
import { listKnocks, resolveKnock, type AdmitAuth, type PendingKnock } from '../lib/api';

/**
 * Poll interval. Frequent enough that someone waiting outside is not left
 * staring at a spinner, infrequent enough to be negligible next to the media
 * the same tab is already carrying.
 */
const POLL_MS = 3_000;

export interface Knocks {
  pending: PendingKnock[];
  admit: (knockId: string) => Promise<void>;
  deny: (knockId: string) => Promise<void>;
}

export function useKnocks(roomId: string, auth: AdmitAuth, active: boolean): Knocks {
  const [pending, setPending] = useState<PendingKnock[]>([]);
  const { hostKey, identity } = auth;

  useEffect(() => {
    if ((!hostKey && !identity) || !active) {
      setPending([]);
      return;
    }

    let cancelled = false;
    let timer = 0;

    const poll = async () => {
      try {
        const { knocks } = await listKnocks(roomId, { hostKey, identity });
        if (!cancelled) setPending(knocks);
      } catch {
        // A transient failure just means the next tick tries again; surfacing
        // it would produce an error banner for a poll nobody asked for.
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), POLL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [roomId, hostKey, identity, active]);

  const resolve = useCallback(
    async (knockId: string, admit: boolean) => {
      if (!hostKey && !identity) return;
      // Removed optimistically: the host has decided, and leaving the row up
      // until the next poll invites a second click on the same person.
      setPending((current) => current.filter((knock) => knock.id !== knockId));
      try {
        await resolveKnock(roomId, knockId, { hostKey, identity }, admit);
      } catch {
        // The next poll restores it if the call did not land.
      }
    },
    [roomId, hostKey, identity],
  );

  return {
    pending,
    admit: (knockId: string) => resolve(knockId, true),
    deny: (knockId: string) => resolve(knockId, false),
  };
}
