/**
 * Home page: logo, create button, join input. Nothing else.
 */
import { useCallback, useRef, useState } from 'react';
import { Logo } from '../components/Logo';
import { ArrowRightIcon, ShieldIcon } from '../components/icons';
import { createRoom, ApiError } from '../lib/api';
import { buildMeetingUrl, generateRoomKey } from '../lib/e2ee';
import { parseMeetingInput } from '../lib/room';
import { copyText } from '../components/CopyLinkButton';
import { navigate } from '../lib/router';

export function Home() {
  const [creating, setCreating] = useState(false);
  const [joinValue, setJoinValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const joinRef = useRef<HTMLInputElement>(null);

  const handleCreate = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setError(null);

    try {
      // The key is generated here, in the browser, and never sent anywhere.
      // The server learns the room ID; only people holding the link learn the key.
      const key = generateRoomKey();
      const { roomId } = await createRoom();
      const url = buildMeetingUrl(window.location.origin, roomId, key);

      // Copy before navigating: the clipboard write must happen inside the
      // user-gesture task, and after a route change some browsers refuse it.
      const didCopy = await copyText(url);
      setCopied(didCopy);

      navigate(`/r/${roomId}#k=${key}`);
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : 'Could not create the meeting. Try again.',
      );
      setCreating(false);
    }
  }, [creating]);

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

      navigate(`/r/${parsed.roomId}#k=${parsed.key}`);
    },
    [joinValue],
  );

  return (
    <div className="flex min-h-full flex-col">
      <header className="px-5 py-5 sm:px-8">
        <Logo />
      </header>

      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 pb-24">
        <h1 className="text-[2rem] leading-[1.15] font-semibold tracking-tight text-balance sm:text-[2.5rem]">
          Private video meetings, instantly.
        </h1>
        <p className="mt-3 text-[0.9375rem] leading-relaxed text-muted">
          No account. No install. End-to-end encrypted.
        </p>

        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={creating}
          className="mt-8 w-full rounded-xl bg-accent px-5 py-3.5 text-base font-semibold text-white transition-colors duration-150 hover:bg-accent-hover disabled:cursor-wait disabled:opacity-60"
        >
          {creating ? 'Creating meeting…' : 'New meeting'}
        </button>

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
            className="tap-target inline-flex shrink-0 items-center justify-center rounded-xl border border-border px-4 font-medium transition-colors duration-150 hover:bg-surface disabled:opacity-40"
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

        <p className="mt-10 flex items-start gap-2 text-[0.8125rem] leading-relaxed text-muted">
          <ShieldIcon className="mt-px h-4 w-4 shrink-0" />
          <span>
            Your meeting key lives in the link, never on the server. Anyone with the link can
            join, so share it carefully.
          </span>
        </p>
      </main>
    </div>
  );
}
