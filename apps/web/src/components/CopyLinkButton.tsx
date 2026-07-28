/**
 * Copy-to-clipboard with an inline confirmation.
 *
 * Falls back to a hidden textarea + execCommand where the async Clipboard API
 * is unavailable (non-secure contexts, older Safari) — copying the meeting link
 * is the primary sharing mechanism and must not silently no-op.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckIcon, CopyIcon } from './icons';

interface Props {
  url: string;
  className?: string;
}

export function CopyLinkButton({ url, className = '' }: Props) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const copy = useCallback(async () => {
    const ok = await copyText(url);
    if (!ok) return;
    setCopied(true);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 2000);
  }, [url]);

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className={`inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-elevated px-3.5 py-2.5 text-sm font-medium transition-colors duration-150 hover:bg-border ${className}`}
    >
      {copied ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}
      {copied ? 'Link copied' : 'Copy meeting link'}
      {/* Announce the result to screen readers, which do not see the icon swap. */}
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? 'Meeting link copied to clipboard' : ''}
      </span>
    </button>
  );
}

export async function copyText(text: string): Promise<boolean> {
  // navigator.clipboard exists only in secure contexts.
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or not user-initiated; fall through.
    }
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
