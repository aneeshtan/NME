/**
 * Pre-join screen.
 *
 * Asks for exactly one thing: a display name. A local camera preview runs
 * alongside it so people can fix their lighting before anyone sees them — this
 * uses getUserMedia directly and never touches the SFU, so nothing leaves the
 * device until Join is pressed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Logo } from '../components/Logo';
import { CameraIcon, CameraOffIcon, MicIcon, MicOffIcon, ShieldIcon } from '../components/icons';
import { DISPLAY_NAME_MAX_LENGTH, loadDisplayName } from '../lib/storage';
import { CopyLinkButton } from '../components/CopyLinkButton';

interface Props {
  roomId: string;
  /** Full shareable link, key included. Empty when the key is missing. */
  meetingUrl: string;
  connecting: boolean;
  micEnabled: boolean;
  cameraEnabled: boolean;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onJoin: (displayName: string) => void;
}

export function PreJoin({
  roomId,
  meetingUrl,
  connecting,
  micEnabled,
  cameraEnabled,
  onToggleMic,
  onToggleCamera,
  onJoin,
}: Props) {
  const [name, setName] = useState(loadDisplayName);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // A returning user's name is already filled in, so send focus to the button
  // instead of making them dismiss a pre-selected field.
  useEffect(() => {
    if (!loadDisplayName()) inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!cameraEnabled) {
      setPreviewError(null);
      return;
    }

    let stream: MediaStream | null = null;
    let cancelled = false;

    navigator.mediaDevices
      .getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then((media) => {
        if (cancelled) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = media;
        if (previewRef.current) previewRef.current.srcObject = media;
      })
      .catch(() => {
        if (!cancelled) setPreviewError('Camera unavailable');
      });

    return () => {
      cancelled = true;
      // Releasing the tracks turns the hardware indicator light off — leaving
      // it on while the user reads an error is alarming and looks like a bug.
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [cameraEnabled]);

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const trimmed = name.trim();
      if (!trimmed || connecting) return;
      onJoin(trimmed);
    },
    [name, connecting, onJoin],
  );

  const canJoin = name.trim().length > 0 && !connecting;

  return (
    <div className="flex min-h-full flex-col">
      <header className="pt-safe px-5 pb-5 sm:px-8">
        <Logo />
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center gap-8 px-5 pb-16 lg:flex-row lg:gap-14">
        <div className="w-full max-w-xl">
          <div className="relative aspect-video overflow-hidden rounded-2xl bg-surface">
            {cameraEnabled && !previewError ? (
              <video
                ref={previewRef}
                autoPlay
                playsInline
                muted
                className="h-full w-full -scale-x-100 object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-sm text-muted">
                {previewError ?? 'Camera is off'}
              </div>
            )}

            <div className="absolute inset-x-0 bottom-0 flex justify-center gap-3 pb-4">
              <PreviewToggle
                on={micEnabled}
                onClick={onToggleMic}
                labelOn="Turn off microphone"
                labelOff="Turn on microphone"
              >
                {micEnabled ? <MicIcon className="h-5 w-5" /> : <MicOffIcon className="h-5 w-5" />}
              </PreviewToggle>
              <PreviewToggle
                on={cameraEnabled}
                onClick={onToggleCamera}
                labelOn="Turn off camera"
                labelOff="Turn on camera"
              >
                {cameraEnabled ? (
                  <CameraIcon className="h-5 w-5" />
                ) : (
                  <CameraOffIcon className="h-5 w-5" />
                )}
              </PreviewToggle>
            </div>
          </div>
        </div>

        <form onSubmit={submit} className="w-full max-w-sm">
          <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight">
            Ready to join?
          </h1>
          <p className="mt-1.5 text-sm text-muted">
            Meeting <span className="font-mono text-fg">{roomId}</span>
          </p>

          {/*
            The most likely reason to be on this screen having just created a
            meeting is to send the link to someone. Without this, the only copy
            control lives behind the in-call participants panel, which means
            joining first just to invite people.
          */}
          {meetingUrl && <CopyLinkButton url={meetingUrl} className="mt-4 w-full" />}

          <label htmlFor="displayName" className="mt-6 block text-sm font-medium">
            Your name
          </label>
          <input
            ref={inputRef}
            id="displayName"
            name="displayName"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={DISPLAY_NAME_MAX_LENGTH}
            autoComplete="nickname"
            autoCapitalize="words"
            spellCheck={false}
            required
            placeholder="e.g. Alex"
            className="mt-2 w-full rounded-xl border border-border bg-elevated px-4 py-3 text-base outline-none transition-colors duration-150 placeholder:text-muted focus:border-accent"
          />

          <button
            type="submit"
            disabled={!canJoin}
            className="mt-4 w-full rounded-xl bg-accent px-5 py-3.5 text-base font-semibold text-white transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
          >
            {connecting ? 'Joining…' : 'Join now'}
          </button>

          <p className="mt-5 flex items-start gap-2 text-[0.8125rem] leading-relaxed text-muted">
            <ShieldIcon className="mt-px h-4 w-4 shrink-0" />
            <span>
              Audio and video are end-to-end encrypted. The server relays the call but cannot
              decrypt it.
            </span>
          </p>
        </form>
      </main>
    </div>
  );
}

function PreviewToggle({
  on,
  onClick,
  labelOn,
  labelOff,
  children,
}: {
  on: boolean;
  onClick: () => void;
  labelOn: string;
  labelOff: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={on ? labelOn : labelOff}
      aria-pressed={!on}
      className={`tap-target inline-flex items-center justify-center rounded-full backdrop-blur transition-colors duration-150 ${
        on ? 'bg-black/45 text-white hover:bg-black/60' : 'bg-danger text-white hover:bg-danger-hover'
      }`}
    >
      {children}
    </button>
  );
}
