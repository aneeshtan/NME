/**
 * Wordmark, and the way back to the home page.
 *
 * The glyph is a rounded aperture — a lens that is also a shield, which is the
 * whole product in one shape.
 *
 * It is a real `<a href="/">` rather than a span with an onClick, so a modified
 * click opens a new tab the way every other link on the web does and the
 * destination appears in the status bar on hover. Plain left-clicks are
 * intercepted and routed client-side instead.
 *
 * Safe on each of the three screens it appears on — home, pre-join, and the
 * post-meeting screen — because none of them is a live call. There is
 * deliberately no logo inside the call: one unconfirmed click that drops a
 * meeting is not worth adding.
 */
import { navigate } from '../lib/router';

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <a
      href="/"
      onClick={(event) => {
        // Anything meaning "open this somewhere else" is left to the browser.
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

        // Already home. Pushing again would stack identical history entries and
        // make the back button appear broken.
        if (window.location.pathname === '/' && !window.location.hash) return;

        /**
         * `/` with no fragment, which is the whole point. A short meeting link
         * is `/#<key>`, so changing the path while leaving the fragment alone
         * would route straight back into the meeting this link exists to leave.
         * `navigate` pushes the resolved URL, and resolving `/` drops it.
         */
        navigate('/');
      }}
      // Naming the anchor stops the glyph and the wordmark being announced a
      // second time inside it.
      aria-label="NME Talk — home"
      className="inline-flex items-center gap-2.5 rounded transition-opacity select-none hover:opacity-80"
    >
      <svg viewBox="0 0 32 32" className="h-7 w-7 shrink-0" aria-hidden="true" focusable="false">
        <rect width="32" height="32" rx="9" className="fill-accent" />
        <path
          d="M11 11.5A1.5 1.5 0 0 1 13.4 10.3l5.8 4.3a1.5 1.5 0 0 1 0 2.4l-5.8 4.3A1.5 1.5 0 0 1 11 20.1z"
          className="fill-white"
        />
      </svg>
      {!compact && (
        <span className="text-[1.0625rem] font-semibold tracking-tight text-fg">NME Talk</span>
      )}
    </a>
  );
}
