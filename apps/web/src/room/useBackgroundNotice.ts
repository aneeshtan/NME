/**
 * Desktop notifications for things that happen while the tab is not on screen.
 *
 * The failure this fixes is specific and common: you start a meeting, send the
 * link, and switch to another tab to keep working. Someone opens the link and
 * knocks. Nothing on your screen changes, because your screen is showing
 * something else — so they wait in a lobby nobody is watching until they give
 * up. The chime in `usePresenceAlerts` does not help either, since a
 * backgrounded tab is often muted.
 *
 * Deliberately *local* notifications, not Web Push. Push would require a
 * subscription endpoint per user stored on the server, a service worker, and
 * VAPID keys — that is, durable per-person state in a control plane that
 * currently holds none, in an app whose privacy claim rests on the server
 * knowing as little as possible. This gets the same result for the case that
 * actually matters, where the page is already open, and costs nothing.
 *
 * Notification bodies never carry message text. A notification can appear on a
 * lock screen, on a shared display, or in a screen recording — all places the
 * message itself was specifically encrypted to stay out of.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

type Permission = 'default' | 'granted' | 'denied' | 'unsupported';

function currentPermission(): Permission {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/**
 * Asks for permission.
 *
 * Must be called from a user gesture. Firefox rejects a request made without
 * one, and a rejection is sticky — the user then has to dig through site
 * settings to undo a prompt they never saw. So this is never called
 * speculatively on load.
 */
export async function requestNoticePermission(): Promise<Permission> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

export interface BackgroundNotice {
  permission: Permission;
  /** Shows a notification, but only when the tab is genuinely out of sight. */
  notify: (options: { tag: string; title: string; body?: string }) => void;
}

export function useBackgroundNotice(): BackgroundNotice {
  const [permission, setPermission] = useState<Permission>(currentPermission);
  const openRef = useRef<Notification[]>([]);

  // Permission can be granted from elsewhere in the app, or revoked in site
  // settings mid-meeting; re-read it when the tab comes back into focus.
  useEffect(() => {
    const sync = () => setPermission(currentPermission());
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
    };
  }, []);

  // Anything still on screen when the meeting ends would outlive the thing it
  // refers to, so it is dismissed with the component.
  useEffect(
    () => () => {
      for (const notification of openRef.current) notification.close();
      openRef.current = [];
    },
    [],
  );

  const notify = useCallback(
    ({ tag, title, body }: { tag: string; title: string; body?: string }) => {
      if (currentPermission() !== 'granted') return;
      // The whole point is the tab being elsewhere. If it is visible, the UI
      // has already said this, and a duplicate notification is just noise.
      if (document.visibilityState === 'visible') return;

      try {
        const notification = new Notification(title, {
          ...(body ? { body } : {}),
          // A tag replaces the previous notification with the same one rather
          // than stacking: four people knocking should read as one situation,
          // not four separate alarms.
          tag,
          icon: '/icon.svg',
          silent: false,
        });

        notification.onclick = () => {
          window.focus();
          notification.close();
        };

        openRef.current = [...openRef.current.filter((n) => n.tag !== tag), notification];
      } catch {
        // Some browsers throw when constructing a Notification outside a
        // service worker. Nothing here is important enough to surface.
      }
    },
    [],
  );

  return { permission, notify };
}
