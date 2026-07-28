/**
 * Minimal router.
 *
 * The app has exactly two routes. A routing library would add ~15 KB gzipped
 * and a context provider for something expressible in forty lines — and on a
 * product whose entire pitch is "fast", that trade is not worth making.
 */
import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'home' }
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

  // Short link: "/" carrying a 43-character key. Anything else is the home page.
  if (pathname === '/' && /^#[A-Za-z0-9_-]{43}$/.test(hash)) {
    return { name: 'meeting', roomId: null };
  }

  return { name: 'home' };
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, getSnapshot, () => cachedRoute);
}
