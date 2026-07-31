/**
 * Minimal router.
 *
 * Four routes: home, a meeting, and two content pages. A routing library would
 * add ~15 KB gzipped and a context provider for something expressible in eighty
 * lines — and on a product whose entire pitch is "fast", that trade is not worth
 * making.
 */
import { useSyncExternalStore } from 'react';
import type { MouseEvent } from 'react';

export type Route =
  | { name: 'home' }
  /** Content pages, served by the SPA rather than by a separate static site. */
  | { name: 'privacy' }
  | { name: 'how' }
  /** Legacy link: the room id is in the path. */
  | { name: 'meeting'; roomId: string }
  /** Short link: the room id is derived from the key in the fragment. */
  | { name: 'meeting'; roomId: null };

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Pushes a new path. The fragment is preserved only when explicitly included. */
export function navigate(path: string, options: { replace?: boolean } = {}): void {
  const method = options.replace ? 'replaceState' : 'pushState';
  window.history[method](null, '', path);
  notify();
}

/**
 * Click handler for an internal `<a href>`.
 *
 * Shared so every in-app link behaves the same way: a modified or non-primary
 * click is left to the browser, so opening a page in a new tab still works and
 * the destination still shows on hover, while a plain click routes without a
 * reload.
 */
export function routeOnClick(path: string) {
  return (event: MouseEvent): void => {
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    ) {
      return;
    }

    event.preventDefault();

    // Already here: pushing again stacks identical history entries and makes
    // the back button appear broken.
    if (window.location.pathname === path && !window.location.hash) return;

    navigate(path);
    // A new page starts at the top; browsers only restore scroll on a real
    // navigation, and pushState is not one.
    window.scrollTo(0, 0);
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', notify);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('popstate', notify);
  };
}

/**
 * Snapshot must be referentially stable between navigations or
 * useSyncExternalStore will loop forever, so the parsed route is memoised
 * against the raw pathname.
 */
let cachedKey = '';
let cachedRoute: Route = { name: 'home' };

function getSnapshot(): Route {
  // The fragment participates in routing now, so it is part of the cache key.
  const key = window.location.pathname + window.location.hash;
  if (key !== cachedKey) {
    cachedKey = key;
    cachedRoute = parseRoute(window.location.pathname, window.location.hash);
  }
  return cachedRoute;
}

function parseRoute(pathname: string, hash: string): Route {
  const match = /^\/r\/([^/]+)\/?$/.exec(pathname);
  if (match?.[1]) {
    return { name: 'meeting', roomId: decodeURIComponent(match[1]).toLowerCase() };
  }

  /**
   * Content pages. They live in the app rather than on a separate static site
   * because Caddy rewrites every unknown path to index.html — so a URL the
   * router does not recognise silently answers with the home page, which is
   * exactly what happened to these two before they were routes.
   *
   * Both must keep resolving: the app stores require a reachable privacy
   * policy, and a reviewer follows the link by hand.
   */
  if (pathname === '/privacy' || pathname === '/privacy/') return { name: 'privacy' };
  if (pathname === '/how-it-works' || pathname === '/how-it-works/') return { name: 'how' };

  // Short link: "/" carrying a 43-character key. Anything else is the home page.
  if (pathname === '/' && /^#[A-Za-z0-9_-]{43}$/.test(hash)) {
    return { name: 'meeting', roomId: null };
  }

  return { name: 'home' };
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, getSnapshot, () => cachedRoute);
}
