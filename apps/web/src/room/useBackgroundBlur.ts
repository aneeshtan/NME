/**
 * Background blur, platform path only.
 *
 * There is deliberately no software fallback. The previous version loaded a
 * segmentation model — 520 KB and a per-frame GPU pipeline — for devices whose
 * camera could not do it themselves. Blur is worth having because it *reduces*
 * bitrate, so paying that much CPU and download to obtain it inverts the whole
 * point. Where the platform offers it, it is free; where it does not, the
 * control simply is not shown.
 *
 * Never on by default. Blur changes how someone appears to other people, and
 * that is not a decision to make on their behalf.
 */
import { useCallback, useEffect, useState } from 'react';
import { Track, type Room } from 'livekit-client';
import { detectNativeBlur, setNativeBlur, type NativeBlurSupport } from './nativeBlur';

export interface BackgroundBlur {
  /** Whether blur is on right now, however it got that way. */
  enabled: boolean;
  native: NativeBlurSupport;
  /** False when the page cannot change it: unsupported, or read-only. */
  available: boolean;
  error: string | null;
  toggle: () => Promise<void>;
}

function localCameraTrack(room: Room | null): MediaStreamTrack | undefined {
  const publication = room?.localParticipant.getTrackPublication(Track.Source.Camera);
  return publication?.track?.mediaStreamTrack;
}

export function useBackgroundBlur(room: Room | null, cameraOn: boolean): BackgroundBlur {
  const [native, setNative] = useState<NativeBlurSupport>({ kind: 'none' });
  const [error, setError] = useState<string | null>(null);

  // Capabilities only exist on a live camera track, so this is re-read whenever
  // the camera comes back on or the device changes. It also picks up a change
  // the user made outside the page — Control Center on macOS, for instance.
  useEffect(() => {
    if (!room || !cameraOn) {
      setNative({ kind: 'none' });
      return;
    }
    setNative(detectNativeBlur(localCameraTrack(room)));
  }, [room, cameraOn]);

  const toggle = useCallback(async () => {
    if (!room) return;
    setError(null);

    const track = localCameraTrack(room);
    if (!track) {
      setError('Turn your camera on first.');
      return;
    }

    if (native.kind !== 'controllable') return;

    const applied = await setNativeBlur(track, !native.enabled);
    if (!applied) {
      // The platform advertised control and then refused. Nothing to fall back
      // to, so say so rather than leaving a checkbox that does nothing.
      setError('Your camera would not change this setting.');
    }

    // Re-read rather than assume: the platform is the source of truth, and it
    // may have applied something other than what was asked for.
    setNative(detectNativeBlur(localCameraTrack(room)));
  }, [room, native]);

  return {
    enabled: native.kind !== 'none' && native.enabled,
    native,
    available: native.kind === 'controllable',
    error,
    toggle,
  };
}
