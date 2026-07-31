/**
 * Chrome shared by the content pages.
 *
 * These used to be a separate static site published from `docs/`. They are
 * served by the app itself now: the repository is private, so nothing can be
 * published from it, and a link in the footer that 404s is worse than no link.
 *
 * Caddy already rewrites unknown paths to index.html, so this needed no server
 * change — only routes, without which both URLs quietly answered with the home
 * page.
 */
import type { ReactNode } from 'react';
import { Logo } from './Logo';
import { Footer } from './Footer';

interface Props {
  title: string;
  /** Rendered under the heading, before the body. */
  intro?: ReactNode;
  updated?: string;
  children: ReactNode;
}

export function PageLayout({ title, intro, updated, children }: Props) {
  return (
    <div className="px-inset flex min-h-full flex-col">
      <header className="pt-safe pb-5">
        <div className="mx-auto w-full max-w-3xl px-6 lg:px-8">
          <Logo />
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8 lg:px-8 lg:py-12">
        <h1 className="text-[2rem] leading-[1.15] font-semibold tracking-tight text-balance sm:text-[2.5rem]">
          {title}
        </h1>
        {updated && <p className="mt-3 text-[0.8125rem] text-muted">Last updated {updated}</p>}
        {intro && (
          <div className="mt-5 text-[1.0625rem] leading-relaxed text-muted">{intro}</div>
        )}
        <div className="mt-10">{children}</div>
      </main>

      <Footer />
    </div>
  );
}

/** A titled block. Sections carry their own heading so the page is skimmable. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10 first:mt-0">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <div className="mt-3 space-y-3 text-[0.9375rem] leading-relaxed text-muted">{children}</div>
    </section>
  );
}

/**
 * A claim and its limit, side by side.
 *
 * Security writing tends to list only the wins. Giving the limits the same
 * visual weight as the guarantees is the point of this component — a tool
 * someone misjudges is more dangerous than one they understand.
 */
export function Claim({ holds, children }: { holds: boolean; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className={`mt-0.5 shrink-0 font-semibold ${holds ? 'text-accent' : 'text-danger'}`}
      >
        {holds ? '✔' : '✘'}
      </span>
      <span className="min-w-0">
        <span className="sr-only">{holds ? 'Protected: ' : 'Not protected: '}</span>
        {children}
      </span>
    </li>
  );
}
