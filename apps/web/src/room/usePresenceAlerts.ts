/**
 * Join and leave notices: a short chime plus a transient line of text.
 *
 * The chime is synthesised with Web Audio rather than shipped as an asset —
 * two sine tones cost nothing to download and cannot fail to decode. Ascending
 * for an arrival, descending for a departure, so the direction is legible
 * without looking at the screen.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { RoomEvent, type Participant, type Room } from 'livekit-client';

export interface PresenceNotice {
  id: number;
  text: string;
}

/** How long a notice stays on screen. */
const NOTICE_MS = 3200;
/**
 * Minimum spacing between chimes. Without this, six people joining at the top
 * of a meeting produce six overlapping tones — the moment the sound is least
 * useful and most irritating.
 */
const CHIME_THROTTLE_MS = 1500;

export function usePresenceAlerts(
  room: Room | null,
  soundEnabled: boolean,
): PresenceNotice[] {
  const [notices, setNotices] = useState<PresenceNotice[]>([]);
  const contextRef = useRef<AudioContext | null>(null);
  const lastChimeRef = useRef(0);
  const soundRef = useRef(soundEnabled);
  soundRef.current = soundEnabled;

  const chime = useCallback((rising: boolean) => {
    if (!soundRef.current) return;

    const now = performance.now();
    if (now - lastChimeRef.current < CHIME_THROTTLE_MS) return;
    lastChimeRef.current = now;

    try {
      // Created lazily and reused: the browser caps how many AudioContexts a
      // page may hold, and a long meeting can produce many events.
      contextRef.current ??= new AudioContext();
      const context = contextRef.current;
      // Autoplay policy may have suspended it; joining was a user gesture.
      if (context.state === 'suspended') void context.resume();

      const start = context.currentTime;
      const tones = rising ? [660, 880] : [660, 440];

      tones.forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;

        const at = start + index * 0.09;
        // Short exponential decay rather than a hard stop, which would click.
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.12, at + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);

        oscillator.connect(gain).connect(context.destination);
        oscillator.start(at);
        oscillator.stop(at + 0.18);
      });
    } catch {
      // Audio unavailable — the text notice still appears.
    }
  }, []);

  const pushNotice = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setNotices((current) => [...current.slice(-2), { id, text }]);
    window.setTimeout(() => {
      setNotices((current) => current.filter((notice) => notice.id !== id));
    }, NOTICE_MS);
  }, []);

  useEffect(() => {
    if (!room) return;

    const onJoin = (participant: Participant) => {
      pushNotice(`${participant.name || 'Someone'} joined`);
      chime(true);
    };
    const onLeave = (participant: Participant) => {
      pushNotice(`${participant.name || 'Someone'} left`);
      chime(false);
    };

    // Only remote participants fire these, so there is no chime for your own
    // arrival — which would be both redundant and startling.
    room.on(RoomEvent.ParticipantConnected, onJoin);
    room.on(RoomEvent.ParticipantDisconnected, onLeave);

    return () => {
      room.off(RoomEvent.ParticipantConnected, onJoin);
      room.off(RoomEvent.ParticipantDisconnected, onLeave);
    };
  }, [room, chime, pushNotice]);

  // Release the audio hardware when the call ends.
  useEffect(
    () => () => {
      void contextRef.current?.close().catch(() => undefined);
      contextRef.current = null;
    },
    [],
  );

  return notices;
}
