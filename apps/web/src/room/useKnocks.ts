/**
 * Host side of the lobby: who is waiting, and admitting or denying them.
 *
 * Only runs for a participant holding the room's host secret, so ordinary
 * participants issue no requests at all.
 */
import { useCallback, useEffect, useState } from 'react';
import { listKnocks, resolveKnock, type PendingKnock } from '../lib/api';

/**
 * Poll interval. Frequent enough that someone waiting outside is not left
 * staring at a spinner, infrequent enough to be negligible next to the media
 * the same tab is already carrying.
 */
const POLL_MS = 3_000;

export interface Knocks {
  pending: PendingKnock[];
  isHost: boolean;
  admit: (knockId: string) => Promise<void>;
  deny: (knockId: string) => Promise<void>;
}

export function useKnocks(roomId: string, hostKey: string | null, active: boolean): Knocks {
  const [pending, setPending] = useState<PendingKnock[]>([]);

  useEffect(() => {
    if (!hostKey || !active) {
      setPending([]);
      return;
    }

    let cancelled = false;
    let timer = 0;

    const poll = async () => {
      try {
        const { knocks } = await listKnocks(roomId, hostKey);
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
  }, [roomId, hostKey, active]);

  const resolve = useCallback(
    async (knockId: string, admit: boolean) => {
      if (!hostKey) return;
      // Removed optimistically: the host has decided, and leaving the row up
      // until the next poll invites a second click on the same person.
      setPending((current) => current.filter((knock) => knock.id !== knockId));
      try {
        await resolveKnock(roomId, knockId, hostKey, admit);
      } catch {
        // The next poll restores it if the call did not land.
      }
    },
    [roomId, hostKey],
  );

  return {
    pending,
    isHost: Boolean(hostKey),
    admit: (knockId: string) => resolve(knockId, true),
    deny: (knockId: string) => resolve(knockId, false),
  };
}
