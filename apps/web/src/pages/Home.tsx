/**
 * Home page.
 *
 * Two columns on a wide screen: what this is on the left, what to do on the
 * right. A single centred column left most of a desktop display empty while
 * squeezing the copy and the controls into one narrow strip — the controls
 * looked cramped and the reasoning had nowhere to go, so neither did its job.
 *
 * The split also puts the actions in a card of their own, which is what makes
 * "New meeting" read as the primary thing on the page rather than one item in
 * a vertical list.
 *
 * On narrow screens it collapses back to one column in DOM order: the headline
 * explains what the page is before asking for a decision.
 */
import { useCallback, useRef, useState } from 'react';
import { Logo } from '../components/Logo';
import { ArrowRightIcon, PeopleIcon, ShieldIcon, VideoOffAllIcon } from '../components/icons';
import { createRoomWithLobby, ApiError } from '@nme/core';
import { buildShortMeetingUrl, deriveRoomId, generateRoomKey } from '@nme/core';
import { parseMeetingInput } from '@nme/core';
import { copyText } from '../components/CopyLinkButton';
import { navigate } from '../lib/router';
import { saveHostKey } from '../lib/storage';

/** The project site, published from `docs/` in the repository. */
const SITE = 'https://aneeshtan.github.io/NME';
const REPO = 'https://github.com/aneeshtan/NME';

export function Home() {
  const [creating, setCreating] = useState(false);
  const [joinValue, setJoinValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [requireApproval, setRequireApproval] = useState(false);
  const joinRef = useRef<HTMLInputElement>(null);

  const handleCreate = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setError(null);

    try {
      // The key is generated here, in the browser, and never sent anywhere.
      // The server learns the room ID; only people holding the link learn the key.
      const key = generateRoomKey();
      // Derived, not requested: the id is a function of the key, so the link
      // only has to carry the key.
      const roomId = await deriveRoomId(key);
      const { hostKey } = await createRoomWithLobby(requireApproval, roomId);

      // Stored, never placed in the URL: the link gets forwarded, and a host
      // secret riding along with it would make the lobby meaningless.
      if (hostKey) saveHostKey(roomId, hostKey);
      const url = buildShortMeetingUrl(window.location.origin, key);

      // Copy before navigating: the clipboard write must happen inside the
      // user-gesture task, and after a route change some browsers refuse it.
      const didCopy = await copyText(url);
      setCopied(didCopy);

      navigate(`/#${key}`);
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : 'Could not create the meeting. Try again.',
      );
      setCreating(false);
    }
  }, [creating, requireApproval]);

  const handleJoin = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      setError(null);

      const parsed = parseMeetingInput(joinValue);
      if (!parsed) {
        setError('Enter a valid meeting code or link.');
        joinRef.current?.focus();
        return;
      }

      if (!parsed.key) {
        setError(
          'That code is missing its encryption key. Paste the full meeting link instead — the part after # is required to decrypt the call.',
        );
        return;
      }

      navigate(`/#${parsed.key}`);
    },
    [joinValue],
  );

  return (
    <div className="flex min-h-full flex-col">
      <header className="pt-safe pb-5">
        <div className="mx-auto w-full max-w-5xl px-6 lg:px-8">
          <Logo />
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-5xl flex-1 grid-cols-1 content-start gap-x-16 gap-y-9 px-6 py-8 lg:grid-cols-[1fr_minmax(0,26rem)] lg:grid-rows-[auto_auto] lg:content-center lg:gap-y-10 lg:px-8 lg:py-16">
        {/* ── What this is ───────────────────────────────────────────────── */}
        <section className="lg:col-start-1 lg:row-start-1">
          <h1 className="text-[2rem] leading-[1.1] font-semibold tracking-tight text-balance sm:text-[2.5rem] lg:text-[3rem]">
            Private video meetings, instantly.
          </h1>
          <p className="mt-4 max-w-md text-[1.0625rem] leading-relaxed text-muted">
            No account. No install. Audio and video are encrypted on your device
            and decrypted only on the devices of the people you invited.
          </p>
        </section>

        {/*
          Second in the DOM, so on a phone the action sits directly under the
          headline instead of below three paragraphs of explanation — someone
          who came here to start a meeting should not have to scroll past the
          reasons to do it. On a wide screen it moves to its own column and
          spans both rows.
        */}
        <section className="w-full self-start rounded-2xl border border-border bg-surface p-6 sm:p-7 lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:self-center">
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={creating}
            className="w-full rounded-xl bg-accent px-5 py-3.5 text-base font-semibold text-white transition-colors duration-150 hover:bg-accent-hover disabled:cursor-wait disabled:opacity-60"
          >
            {creating ? 'Creating meeting…' : 'New meeting'}
          </button>

          <label className="mt-4 flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={requireApproval}
              onChange={(event) => setRequireApproval(event.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
            />
            <span>
              <span className="block text-sm font-medium">Require approval to join</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                People who open the link wait until someone already in the meeting
                lets them in, so a forwarded invitation cannot admit a stranger
                silently.
              </span>
            </span>
          </label>

          <div className="my-6 flex items-center gap-3" aria-hidden="true">
            <span className="h-px flex-1 bg-border" />
            <span className="text-xs font-medium tracking-wide text-muted uppercase">or</span>
            <span className="h-px flex-1 bg-border" />
          </div>

          <form onSubmit={handleJoin} className="flex gap-2">
            <label htmlFor="joinCode" className="sr-only">
              Meeting code or link
            </label>
            <input
              ref={joinRef}
              id="joinCode"
              type="text"
              value={joinValue}
              onChange={(event) => setJoinValue(event.target.value)}
              placeholder="Enter a code or link"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-xl border border-border bg-elevated px-4 py-3 text-base outline-none transition-colors duration-150 placeholder:text-muted focus:border-accent"
            />
            <button
              type="submit"
              disabled={!joinValue.trim()}
              aria-label="Join meeting"
              className="tap-target inline-flex shrink-0 items-center justify-center rounded-xl border border-border px-4 font-medium transition-colors duration-150 hover:bg-elevated disabled:opacity-40"
            >
              <ArrowRightIcon className="h-5 w-5" />
            </button>
          </form>

          <div aria-live="polite" className="min-h-6">
            {error && (
              <p role="alert" className="mt-3 text-sm leading-relaxed text-danger">
                {error}
              </p>
            )}
            {copied && !error && (
              <p className="mt-3 text-sm text-muted">Meeting link copied to clipboard.</p>
            )}
          </div>

          <p className="mt-4 text-[0.8125rem] leading-relaxed text-muted">
            Anyone with the link can join, so share it the way you would share a
            password.
          </p>
        </section>

        {/*
          Three claims, not six. Each is something a person can act on when
          deciding whether to send this link to a colleague — and the last one
          is a limit rather than a feature, because that is the honest part.
        */}
        <ul className="grid content-start gap-5 sm:max-w-md lg:col-start-1 lg:row-start-2">
          <Point icon={<ShieldIcon className="h-[1.125rem] w-[1.125rem]" />} title="The server relays, it cannot listen">
            Your meeting key lives in the link, after the <code className="rounded bg-elevated px-1 py-px text-[0.8125rem]">#</code> — the one
            part of a URL browsers never send to a server.
          </Point>
          <Point icon={<PeopleIcon className="h-[1.125rem] w-[1.125rem]" />} title="No accounts, ever">
            A meeting is a link. There is nothing to sign up for, and no
            directory of who uses this.
          </Point>
          <Point icon={<VideoOffAllIcon className="h-[1.125rem] w-[1.125rem]" />} title="Nothing is recorded">
            No recordings, no transcripts, no chat history. Messages live in
            memory and are gone when the tab closes.
          </Point>
        </ul>
      </main>

      {/*
        Where someone goes to check the claims above rather than take them on
        trust. `rel="noreferrer"` keeps the meeting URL out of the Referer
        header on the way out — the fragment is never sent, but the path can be.
      */}
      <footer className="mt-auto border-t border-border py-6">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-6 text-[0.8125rem] text-muted lg:px-8">
          <span>End-to-end encrypted meetings.</span>
          <nav className="flex flex-wrap gap-x-6 gap-y-2 sm:ml-auto">
            <a className="transition-colors hover:text-fg" href={SITE} target="_blank" rel="noreferrer">
              How it works
            </a>
            <a className="transition-colors hover:text-fg" href={`${SITE}/privacy.html`} target="_blank" rel="noreferrer">
              Privacy
            </a>
            <a className="transition-colors hover:text-fg" href={`${SITE}/support.html`} target="_blank" rel="noreferrer">
              Support
            </a>
            <a className="transition-colors hover:text-fg" href={REPO} target="_blank" rel="noreferrer">
              Source
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}

function Point({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3.5">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[0.9375rem] font-medium">{title}</span>
        <span className="mt-1 block text-[0.875rem] leading-relaxed text-muted">{children}</span>
      </span>
    </li>
  );
}
