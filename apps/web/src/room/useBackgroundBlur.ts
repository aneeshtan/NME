/**
 * Background blur, preferring whatever costs least.
 *
 * Order of preference:
 *  1. The platform's own blur, where the camera or OS provides it — free.
 *  2. A lazily-loaded GPU pipeline, fetched only on first use.
 *
 * Neither is on by default: blur is never free enough to impose on someone who
 * did not ask for it.
 */
import { useCallback, useEffect, useState } from 'react';
import { Track, type Room } from 'livekit-client';
import {
  detectNativeBlur,
  isWebGLAvailable,
  setNativeBlur,
  type NativeBlurSupport,
} from './nativeBlur';

export type BlurMode = 'off' | 'native' | 'gpu';

export interface BackgroundBlur {
  mode: BlurMode;
  native: NativeBlurSupport;
  /** True while the GPU pipeline is being fetched and initialised. */
  loading: boolean;
  /** False where neither path is available. */
  available: boolean;
  error: string | null;
  toggle: () => Promise<void>;
}

function localCameraTrack(room: Room | null): MediaStreamTrack | undefined {
  const publication = room?.localParticipant.getTrackPublication(Track.Source.Camera);
  return publication?.track?.mediaStreamTrack;
}

export function useBackgroundBlur(room: Room | null, cameraOn: boolean): BackgroundBlur {
  const [mode, setMode] = useState<BlurMode>('off');
  const [native, setNative] = useState<NativeBlurSupport>({ kind: 'none' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gpuSupported] = useState(isWebGLAvailable);

  // Capabilities only exist on a live camera track, so this is re-read whenever
  // the camera comes back on or the device changes.
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

    const publication = room.localParticipant.getTrackPublication(Track.Source.Camera);
    const videoTrack = publication?.track;
    if (!videoTrack) {
      setError('Turn your camera on first.');
      return;
    }

    // Turning it off: unwind whichever path is active.
    if (mode !== 'off') {
      if (mode === 'native') await setNativeBlur(videoTrack.mediaStreamTrack, false);
      else await (videoTrack as { stopProcessor?: () => Promise<void> }).stopProcessor?.();
      setMode('off');
      setNative(detectNativeBlur(localCameraTrack(room)));
      return;
    }

    // Free path first.
    if (native.kind === 'controllable') {
      const applied = await setNativeBlur(videoTrack.mediaStreamTrack, true);
      if (applied) {
        setMode('native');
        return;
      }
      // Fall through: the platform advertised control but refused.
    }

    if (!gpuSupported) {
      setError('This device cannot blur the background.');
      return;
    }

    setLoading(true);
    try {
      const { BackgroundBlurProcessor } = await import('./blurProcessor');
      const processor = new BackgroundBlurProcessor();
      await (
        videoTrack as { setProcessor: (p: unknown, local?: boolean) => Promise<void> }
      ).setProcessor(processor, true);
      setMode('gpu');
    } catch {
      setError('Could not start background blur.');
    } finally {
      setLoading(false);
    }
  }, [room, mode, native, gpuSupported]);

  /**
   * A camera switched off takes its processor with it, so the UI must not keep
   * claiming blur is on.
   */
  useEffect(() => {
    if (!cameraOn && mode !== 'off') setMode('off');
  }, [cameraOn, mode]);

  return {
    mode,
    native,
    loading,
    // Read-only platform blur counts as "available" only in the sense that we
    // can report it; it is not something the page can switch on.
    available: native.kind === 'controllable' || gpuSupported,
    error,
    toggle,
  };
}
