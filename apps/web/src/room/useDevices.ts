/**
 * Media device enumeration and selection.
 *
 * Browsers withhold device *labels* until a media permission has been granted —
 * before that, `enumerateDevices` returns entries with empty names. So the list
 * is (re)read after the local tracks exist, and refreshed whenever the OS
 * reports a change, which is what makes plugging in a headset mid-call work.
 */
import { useCallback, useEffect, useState } from 'react';
import { Room } from 'livekit-client';

export type DeviceKind = 'audioinput' | 'videoinput' | 'audiooutput';

export interface DeviceState {
  devices: Record<DeviceKind, MediaDeviceInfo[]>;
  selected: Record<DeviceKind, string>;
  select: (kind: DeviceKind, deviceId: string) => Promise<void>;
  /** False where the browser cannot redirect audio output (Firefox, iOS). */
  canSelectOutput: boolean;
}

const STORAGE_KEY = 'nme.devices';
const KINDS: DeviceKind[] = ['audioinput', 'videoinput', 'audiooutput'];

const EMPTY: Record<DeviceKind, MediaDeviceInfo[]> = {
  audioinput: [],
  videoinput: [],
  audiooutput: [],
};

function loadSelection(): Record<DeviceKind, string> {
  const empty = { audioinput: '', videoinput: '', audiooutput: '' };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      audioinput: typeof parsed.audioinput === 'string' ? parsed.audioinput : '',
      videoinput: typeof parsed.videoinput === 'string' ? parsed.videoinput : '',
      audiooutput: typeof parsed.audiooutput === 'string' ? parsed.audiooutput : '',
    };
  } catch {
    return empty;
  }
}

function saveSelection(selection: Record<DeviceKind, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // Storage unavailable; the choice simply will not persist.
  }
}

export function useDevices(room: Room | null): DeviceState {
  const [devices, setDevices] = useState(EMPTY);
  const [selected, setSelected] = useState(loadSelection);

  const refresh = useCallback(async () => {
    try {
      const lists = await Promise.all(
        KINDS.map((kind) => Room.getLocalDevices(kind, false).catch(() => [])),
      );
      setDevices({
        audioinput: lists[0] ?? [],
        videoinput: lists[1] ?? [],
        audiooutput: lists[2] ?? [],
      });
    } catch {
      // Enumeration can reject in locked-down contexts; keep the last list.
    }
  }, []);

  useEffect(() => {
    void refresh();

    // Fires when a device is plugged in or removed — the case that makes a
    // static, join-time device list wrong halfway through a meeting.
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh);
  }, [refresh]);

  // Labels arrive only once permission is granted, so re-read once connected.
  useEffect(() => {
    if (room) void refresh();
  }, [room, refresh]);

  /**
   * Applies a stored preference once the room exists. Without this, a device
   * chosen in a previous meeting would be remembered in the UI but the call
   * would still open on the OS default.
   */
  useEffect(() => {
    if (!room) return;
    for (const kind of KINDS) {
      const deviceId = selected[kind];
      if (deviceId) void room.switchActiveDevice(kind, deviceId).catch(() => undefined);
    }
    // Runs once per connection, not on every subsequent manual change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room]);

  const select = useCallback(
    async (kind: DeviceKind, deviceId: string) => {
      const next = { ...selected, [kind]: deviceId };
      setSelected(next);
      saveSelection(next);

      if (room) {
        // Failure here is not fatal — the device may have been unplugged
        // between enumeration and selection.
        await room.switchActiveDevice(kind, deviceId).catch(() => undefined);
      }
    },
    [room, selected],
  );

  return {
    devices,
    selected,
    select,
    // Chrome and Edge implement setSinkId; Firefox and iOS Safari do not, and
    // offering a picker that silently does nothing is worse than hiding it.
    canSelectOutput:
      typeof HTMLMediaElement !== 'undefined' &&
      'setSinkId' in HTMLMediaElement.prototype,
  };
}
