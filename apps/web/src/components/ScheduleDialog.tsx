/**
 * "Add to calendar" dialog.
 *
 * Native date and duration inputs: they are keyboard and screen-reader correct
 * without work, render as the platform picker on mobile, and add nothing to the
 * bundle.
 */
import { useEffect, useRef, useState } from 'react';
import { downloadIcs, nextHalfHour, toDateTimeLocal } from '../lib/calendar';
import { CloseIcon, ShieldIcon } from './icons';

interface Props {
  meetingUrl: string;
  onClose: () => void;
}

const DURATIONS = [15, 30, 45, 60, 90] as const;

export function ScheduleDialog({ meetingUrl, onClose }: Props) {
  const [title, setTitle] = useState('Meeting');
  const [start, setStart] = useState(() => toDateTimeLocal(nextHalfHour()));
  const [duration, setDuration] = useState<number>(30);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.select();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = new Date(start);
    if (Number.isNaN(parsed.getTime())) return;

    downloadIcs({ title: title.trim() || 'Meeting', start: parsed, durationMinutes: duration, meetingUrl });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Add meeting to calendar"
        className="w-full max-w-sm rounded-2xl border border-border bg-elevated p-5 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">Add to calendar</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 inline-flex h-8 w-8 items-center justify-center rounded-full text-muted hover:text-fg"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <label className="block text-sm font-medium" htmlFor="eventTitle">
          Title
        </label>
        <input
          ref={titleRef}
          id="eventTitle"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={100}
          className="mt-1.5 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        />

        <label className="mt-3.5 block text-sm font-medium" htmlFor="eventStart">
          Starts
        </label>
        <input
          id="eventStart"
          type="datetime-local"
          value={start}
          onChange={(event) => setStart(event.target.value)}
          required
          className="mt-1.5 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        />

        <label className="mt-3.5 block text-sm font-medium" htmlFor="eventDuration">
          Length
        </label>
        <select
          id="eventDuration"
          value={duration}
          onChange={(event) => setDuration(Number(event.target.value))}
          className="mt-1.5 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        >
          {DURATIONS.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes} minutes
            </option>
          ))}
        </select>

        {/*
          Stated before the download, not after. The meeting link carries the
          encryption key, so putting it in a hosted calendar means that provider
          — and everyone the invitation reaches — can join and decrypt the call.
          That may well be an acceptable trade for a work meeting, but it should
          be a decision rather than a surprise.
        */}
        <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-muted">
          <ShieldIcon className="mt-px h-4 w-4 shrink-0" />
          <span>
            The invitation contains the meeting&rsquo;s encryption key. Anyone who can read it
            — including your calendar provider — can join and decrypt the call.
          </span>
        </p>

        <button
          type="submit"
          className="mt-4 w-full rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent-hover"
        >
          Download invitation
        </button>
      </form>
    </div>
  );
}
