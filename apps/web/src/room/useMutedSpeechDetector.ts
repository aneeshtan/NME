/**
 * Detects speech while muted, so "you're on mute" surfaces before the sentence
 * is finished.
 *
 * ── Why this is opt-in ──────────────────────────────────────────────────────
 * Muting in WebRTC sets `track.enabled = false`, which makes the track emit
 * silence. Analysing the published track while muted therefore detects nothing,
 * and the only way to hear speech is to hold a *second*, un-muted microphone
 * stream open for the whole time the user believes they are muted.
 *
 * In an app whose premise is privacy that is not a decision to make quietly,
 * even though the audio never leaves the device — it is analysed in an
 * AudioContext and discarded frame by frame, never encoded, never published.
 * So it is off by default and labelled plainly in the settings panel.
 *
 * The stream is opened only while muted and torn down the moment the mic is
 * live again, which also keeps the OS recording indicator honest.
 */
import { useEffect, useState } from 'react';

/** RMS above this counts as speech rather than room noise. */
const SPEECH_THRESHOLD = 0.02;
/** Sustained speech required before warning, so a cough does not trigger it. */
const SUSTAIN_MS = 700;
/** How long the hint stays up once shown. */
const HINT_MS = 3000;

export function useMutedSpeechDetector(enabled: boolean, deviceId: string): boolean {
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setSpeaking(false);
      return;
    }

    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let frame = 0;
    let hintTimer = 0;
    let speechStartedAt = 0;
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
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        // Small FFT: this measures loudness, not spectrum, so the cheapest
        // window that still smooths out single-sample spikes is enough.
        analyser.fftSize = 512;
        source.connect(analyser);

        const samples = new Float32Array(analyser.fftSize);

        const tick = () => {
          if (cancelled || !context) return;
          analyser.getFloatTimeDomainData(samples);

          let sum = 0;
          for (const sample of samples) sum += sample * sample;
          const rms = Math.sqrt(sum / samples.length);

          const now = performance.now();
          if (rms > SPEECH_THRESHOLD) {
            if (speechStartedAt === 0) speechStartedAt = now;
            if (now - speechStartedAt > SUSTAIN_MS) {
              setSpeaking(true);
              window.clearTimeout(hintTimer);
              hintTimer = window.setTimeout(() => setSpeaking(false), HINT_MS);
              speechStartedAt = now;
            }
          } else {
            speechStartedAt = 0;
          }

          frame = requestAnimationFrame(tick);
        };

        frame = requestAnimationFrame(tick);
      } catch {
        // Permission denied or device busy — the feature simply stays inactive.
      }
    };

    void start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(hintTimer);
      // Releasing the stream turns the OS recording indicator back off.
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close().catch(() => undefined);
      setSpeaking(false);
    };
  }, [enabled, deviceId]);

  return speaking;
}
