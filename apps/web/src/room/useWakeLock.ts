/**
 * Keeps the screen awake for the duration of a call.
 *
 * Without this a phone dims and locks after its idle timeout while you are
 * listening rather than touching the screen — which on mobile also suspends
 * video rendering. Progressive enhancement: the API is absent on iOS Safari
 * before 16.4 and in Firefox, where the effect is simply the previous
 * behaviour.
 */
import { useEffect } from 'react';

export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let released = false;

    const acquire = async () => {
      try {
        sentinel = await navigator.wakeLock.request('screen');
      } catch {
        // Denied, or the document was not visible. Not worth surfacing.
      }
    };

    /**
     * Browsers drop the lock whenever the tab is hidden, and do not restore it
     * on return — so without re-acquiring, the screen would start sleeping
     * again after the first time the user switched apps mid-call.
     */
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && !released) void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      released = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      void sentinel?.release().catch(() => undefined);
    };
  }, [active]);
}
