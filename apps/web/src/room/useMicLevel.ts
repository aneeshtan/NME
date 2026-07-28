/**
 * Live microphone level for the pre-join screen.
 *
 * "Can you hear me?" is the most common way a meeting starts badly, and until
 * now this screen previewed the camera while saying nothing at all about the
 * microphone — the one device you cannot check by looking. A bar that moves
 * when you speak answers it before anyone joins.
 *
 * Entirely local: an AnalyserNode reading the same pre-join stream, never
 * recorded, never published, torn down with the screen.
 */
import { useEffect, useRef, useState } from 'react';

/** Smoothing, so the bar reads as a voice rather than flickering per frame. */
const ATTACK = 0.5;
const RELEASE = 0.12;

export function useMicLevel(enabled: boolean, deviceId: string): number {
  const [level, setLevel] = useState(0);
  const smoothed = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setLevel(0);
      smoothed.current = 0;
      return;
    }

    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let frame = 0;
    let cancelled = false;

    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        context = new AudioContext();
        const analyser = context.createAnalyser();
        // Loudness, not spectrum — the smallest window that still smooths out
        // single-sample spikes is enough.
        analyser.fftSize = 512;
        context.createMediaStreamSource(stream).connect(analyser);

        const samples = new Float32Array(analyser.fftSize);

        const tick = () => {
          if (cancelled) return;
          analyser.getFloatTimeDomainData(samples);

          let sum = 0;
          for (const sample of samples) sum += sample * sample;
          const rms = Math.sqrt(sum / samples.length);

          // Scaled so ordinary speech fills most of the bar rather than a
          // sliver — raw RMS on a linear bar looks broken even when working.
          const target = Math.min(1, rms * 8);
          const rate = target > smoothed.current ? ATTACK : RELEASE;
          smoothed.current += (target - smoothed.current) * rate;

          setLevel(smoothed.current);
          frame = requestAnimationFrame(tick);
        };

        frame = requestAnimationFrame(tick);
      } catch {
        // Permission denied or the device is busy; the bar simply stays flat
        // and the surrounding copy explains what that means.
      }
    };

    void start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      // Releasing the stream turns the OS recording indicator back off.
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close().catch(() => undefined);
    };
  }, [enabled, deviceId]);

  return level;
}
