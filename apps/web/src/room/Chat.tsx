/**
 * In-meeting chat.
 *
 * Messages are end-to-end encrypted like the media, live only in memory, and
 * are gone when the tab closes — there is no history to fetch because nothing
 * is ever stored. Anyone joining late sees an empty panel, which is the honest
 * consequence of having no server-side record.
 */
import { useEffect, useRef, useState } from 'react';
import type { Messaging } from './useMessaging';
import { CloseIcon } from '../components/icons';
import { POLL_CHOICES, POLL_QUESTION_MAX } from '../lib/messaging';

interface Props {
  messaging: Messaging;
  onClose: () => void;
}

export function Chat({ messaging, onClose }: Props) {
  const [draft, setDraft] = useState('');
  const [pollDraft, setPollDraft] = useState('');
  const [composingPoll, setComposingPoll] = useState(false);
  const { poll } = messaging;
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { messages } = messaging;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Follow the conversation as it grows.
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void messaging.sendChat(text);
  };

  return (
    <aside
      className="absolute inset-0 z-20 flex h-full w-full flex-col bg-surface sm:static sm:z-auto sm:w-80 sm:border-l sm:border-border"
      aria-label="Chat"
    >
      <header className="flex items-center justify-between px-4 py-3.5">
        <h2 className="text-sm font-semibold">Chat</h2>
        <button
          type="button"
          onClick={() => setComposingPoll((open) => !open)}
          className="ml-auto mr-1 rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-elevated hover:text-fg"
        >
          Poll
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close chat"
          className="tap-target -mr-2 inline-flex items-center justify-center rounded-full text-muted hover:text-fg"
        >
          <CloseIcon className="h-4.5 w-4.5" />
        </button>
      </header>

      {composingPoll && (
        <form
          className="border-b border-border px-4 pb-3"
          onSubmit={(event) => {
            event.preventDefault();
            const question = pollDraft.trim();
            if (!question) return;
            void messaging.startPoll(question);
            setPollDraft('');
            setComposingPoll(false);
          }}
        >
          <label htmlFor="pollQuestion" className="sr-only">
            Poll question
          </label>
          <input
            id="pollQuestion"
            value={pollDraft}
            onChange={(event) => setPollDraft(event.target.value)}
            maxLength={POLL_QUESTION_MAX}
            placeholder="Ask a yes / no question"
            className="w-full rounded-lg border border-border bg-elevated px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={!pollDraft.trim()}
            className="mt-2 w-full rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
          >
            Ask everyone
          </button>
        </form>
      )}

      {poll && <PollCard messaging={messaging} />}

      <div
        ref={listRef}
        className="flex-1 overflow-y-auto px-4 pb-2"
        role="log"
        aria-live="polite"
      >
        {messages.length === 0 ? (
          <p className="mt-6 text-center text-[0.8125rem] leading-relaxed text-muted">
            Messages are encrypted and disappear when the meeting ends.
          </p>
        ) : (
          messages.map((message) => (
            <div key={message.id} className="mb-3">
              <div className="flex items-baseline gap-2">
                <span className="truncate text-xs font-semibold">
                  {message.isLocal ? 'You' : message.senderName}
                </span>
                <span className="shrink-0 text-[0.6875rem] text-muted">
                  {new Date(message.at).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
              {/* React escapes this; the sender is a peer, not a trusted source. */}
              <p className="mt-0.5 text-sm leading-relaxed break-words whitespace-pre-wrap">
                {message.text}
              </p>
            </div>
          ))
        )}
      </div>

      <form onSubmit={submit} className="flex gap-2 border-t border-border p-3">
        <label htmlFor="chatInput" className="sr-only">
          Message
        </label>
        <input
          ref={inputRef}
          id="chatInput"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Send a message"
          maxLength={2000}
          autoComplete="off"
          className="min-w-0 flex-1 rounded-lg border border-border bg-elevated px-3 py-2 text-sm outline-none placeholder:text-muted focus:border-accent"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          className="shrink-0 rounded-lg bg-accent px-3.5 text-sm font-semibold text-white disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </aside>
  );
}

/**
 * Live poll. Tallied entirely client-side from votes that arrived encrypted —
 * the server sees ciphertext and never learns the question or the result.
 */
function PollCard({ messaging }: { messaging: Messaging }) {
  const poll = messaging.poll;
  if (!poll) return null;

  const counts = { yes: 0, no: 0, abstain: 0 };
  for (const choice of poll.votes.values()) counts[choice] += 1;
  const total = poll.votes.size;

  return (
    <div className="border-b border-border px-4 pb-3">
      <p className="text-xs font-semibold text-muted">{poll.askedBy} asked</p>
      <p className="mt-1 text-sm leading-snug break-words">{poll.question}</p>

      <div className="mt-2.5 flex gap-1.5">
        {POLL_CHOICES.map((choice) => (
          <button
            key={choice}
            type="button"
            onClick={() => void messaging.castVote(choice)}
            aria-pressed={poll.myVote === choice}
            className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium capitalize ${
              poll.myVote === choice
                ? 'border-accent bg-accent text-white'
                : 'border-border hover:bg-elevated'
            }`}
          >
            {choice}
          </button>
        ))}
      </div>

      <div className="mt-2 space-y-1">
        {POLL_CHOICES.map((choice) => (
          <div key={choice} className="flex items-center gap-2 text-[0.6875rem] text-muted">
            <span className="w-14 capitalize">{choice}</span>
            <span className="h-1 flex-1 overflow-hidden rounded-full bg-surface">
              <span
                className="block h-full rounded-full bg-accent"
                style={{ width: `${total ? (counts[choice] / total) * 100 : 0}%` }}
              />
            </span>
            <span className="w-4 text-right">{counts[choice]}</span>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={messaging.closePoll}
        className="mt-2 text-[0.6875rem] font-medium text-muted underline"
      >
        Dismiss
      </button>
    </div>
  );
}
