/**
 * Device selection popover.
 *
 * Native <select> elements rather than a custom dropdown: they are keyboard and
 * screen-reader correct for free, render as the platform picker on mobile
 * (which is far easier to use one-handed than any custom list), and cost
 * nothing in bundle size.
 */
import { useEffect, useRef } from 'react';
import type { DeviceKind, DeviceState } from './useDevices';
import { CloseIcon } from '../components/icons';

interface Props {
  state: DeviceState;
  audioOnly: boolean;
  onToggleAudioOnly: () => void;
  warnWhenMuted: boolean;
  onToggleWarnWhenMuted: () => void;
  presenceSound: boolean;
  onTogglePresenceSound: () => void;
  onClose: () => void;
}

const LABELS: Record<DeviceKind, string> = {
  audioinput: 'Microphone',
  videoinput: 'Camera',
  audiooutput: 'Speaker',
};

export function DeviceMenu({
  state,
  audioOnly,
  onToggleAudioOnly,
  warnWhenMuted,
  onToggleWarnWhenMuted,
  presenceSound,
  onTogglePresenceSound,
  onClose,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Dismiss on Escape and on a click outside — expected of any popover, and
  // the only way to close it on a phone without hunting for the X.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) onClose();
    };

    window.addEventListener('keydown', onKeyDown);
    // Deferred so the click that opened the menu does not immediately close it.
    const timer = window.setTimeout(
      () => window.addEventListener('pointerdown', onPointerDown),
      0,
    );

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onClose]);

  const kinds: DeviceKind[] = state.canSelectOutput
    ? ['audioinput', 'videoinput', 'audiooutput']
    : ['audioinput', 'videoinput'];

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Audio and video settings"
      className="absolute bottom-full left-1/2 z-30 mb-3 w-[min(20rem,calc(100vw-1.5rem))] -translate-x-1/2 rounded-2xl border border-border bg-elevated p-4 shadow-xl"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Settings</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close settings"
          className="-mr-1 inline-flex h-8 w-8 items-center justify-center rounded-full text-muted hover:text-fg"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      {kinds.map((kind) => {
        const list = state.devices[kind];
        return (
          <label key={kind} className="mb-3 block last:mb-0">
            <span className="mb-1.5 block text-xs font-medium text-muted">{LABELS[kind]}</span>
            <select
              value={state.selected[kind] || list[0]?.deviceId || ''}
              onChange={(event) => void state.select(kind, event.target.value)}
              disabled={list.length === 0}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
            >
              {list.length === 0 && <option value="">No devices found</option>}
              {list.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {/* Labels are blank until a permission is granted. */}
                  {device.label || `${LABELS[kind]} ${index + 1}`}
                </option>
              ))}
            </select>
          </label>
        );
      })}

      {/*
        Audio-only lives here rather than in the toolbar. It is a preference,
        not a primary control, and the toolbar has no room for a seventh button
        on a 360px phone — which is precisely where saving mobile data matters
        most, so hiding it on small screens would have removed it from the
        people most likely to want it.
      */}
      <label className="mt-4 flex cursor-pointer items-start gap-2.5 border-t border-border pt-3.5">
        <input
          type="checkbox"
          checked={audioOnly}
          onChange={onToggleAudioOnly}
          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
        />
        <span>
          <span className="block text-sm font-medium">Audio only</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted">
            Stop receiving video to save data and battery. Others can still see you.
          </span>
        </span>
      </label>

      <label className="mt-3 flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          checked={presenceSound}
          onChange={onTogglePresenceSound}
          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
        />
        <span>
          <span className="block text-sm font-medium">Join and leave sounds</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted">
            A short chime when someone enters or leaves.
          </span>
        </span>
      </label>

      {/*
        Opt-in, and labelled with what it actually does. Detecting speech while
        muted requires holding a second microphone stream open for as long as
        the user believes they are muted — the audio never leaves the device,
        but enabling that silently in a privacy-first app would be wrong.
      */}
      <label className="mt-3 flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          checked={warnWhenMuted}
          onChange={onToggleWarnWhenMuted}
          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
        />
        <span>
          <span className="block text-sm font-medium">Warn me when I speak while muted</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted">
            Keeps the microphone active while muted so speech can be detected on
            this device. Nothing is sent or recorded.
          </span>
        </span>
      </label>
    </div>
  );
}
