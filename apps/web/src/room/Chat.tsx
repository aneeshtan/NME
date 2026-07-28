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

interface Props {
  messaging: Messaging;
  onClose: () => void;
}

export function Chat({ messaging, onClose }: Props) {
  const [draft, setDraft] = useState('');
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
          onClick={onClose}
          aria-label="Close chat"
          className="tap-target -mr-2 inline-flex items-center justify-center rounded-full text-muted hover:text-fg"
        >
          <CloseIcon className="h-4.5 w-4.5" />
        </button>
      </header>

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
