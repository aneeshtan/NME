import { Component, Suspense, lazy, type ErrorInfo, type ReactNode } from 'react';
import { Home } from './pages/Home';
import { useRoute } from './lib/router';

/**
 * The meeting bundle — LiveKit client, E2EE worker, media UI — is split out and
 * fetched only on a `/r/:id` route. This keeps the home page's JavaScript to a
 * few kilobytes and its first paint effectively instant.
 */
const Meeting = lazy(() => import('./pages/Meeting'));

/**
 * Content pages are split out for the same reason: someone arriving to start a
 * meeting should not download a privacy policy to do it.
 */
const Privacy = lazy(() => import('./pages/Privacy'));
const HowItWorks = lazy(() => import('./pages/HowItWorks'));
const Health = lazy(() => import('./pages/Health'));

export function App() {
  const route = useRoute();

  if (route.name === 'meeting') {
    return (
      // The meeting surface is always dark, independent of system preference.
      <div data-surface="meeting" className="h-full bg-bg text-fg">
        <ErrorBoundary>
          <Suspense fallback={<RouteFallback />}>
            <Meeting roomId={route.roomId} />
          </Suspense>
        </ErrorBoundary>
      </div>
    );
  }

  if (route.name === 'privacy' || route.name === 'how' || route.name === 'health') {
    return (
      <ErrorBoundary>
        <Suspense fallback={<RouteFallback />}>
          {route.name === 'privacy' ? <Privacy /> : null}
          {route.name === 'how' ? <HowItWorks /> : null}
          {route.name === 'health' ? <Health /> : null}
        </Suspense>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <Home />
    </ErrorBoundary>
  );
}

function RouteFallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-border border-t-accent" />
      <span className="sr-only">Loading</span>
    </div>
  );
}

/**
 * Last line of defence. A render crash inside a meeting would otherwise leave a
 * blank page with the camera light still on; this at least surfaces a way out.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled UI error', error, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return this.props.children;

    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-[0.9375rem]">Something went wrong.</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent-hover"
        >
          Reload
        </button>
      </div>
    );
  }
}
