/**
 * One row, shared by every page.
 *
 * Extracted from the home page when the content pages arrived — three copies of
 * a footer is how the copyright year ends up different on each one.
 *
 * Both links are internal. They used to point at a static site published from
 * the repository; they are routes in the app now.
 *
 * No Source link here by request — the repository is linked from the body of
 * both content pages instead, where it supports the "check this yourself" claim
 * rather than sitting in a nav row.
 */
import { routeOnClick } from '../lib/router';

export function Footer() {
  return (
    <footer className="mt-auto border-t border-border py-6">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-6 text-[0.8125rem] text-muted lg:px-8">
        <span>&copy; {__BUILD_YEAR__} NME Talk</span>
        <span aria-hidden="true">&middot;</span>
        <span>
          Version <span className="font-mono">{__APP_VERSION__}</span>
        </span>
        <span aria-hidden="true">&middot;</span>
        <span>Created by AI, designed by F&amp;G</span>

        <nav className="flex flex-wrap gap-x-6 gap-y-2 sm:ml-auto">
          <a
            className="transition-colors hover:text-fg"
            href="/how-it-works"
            onClick={routeOnClick('/how-it-works')}
          >
            How it works
          </a>
          <a
            className="transition-colors hover:text-fg"
            href="/privacy"
            onClick={routeOnClick('/privacy')}
          >
            Privacy
          </a>
        </nav>
      </div>
    </footer>
  );
}
