/**
 * Room lifecycle as a React hook.
 *
 * LiveKit's `Room` is an event emitter holding authoritative mutable state.
 * Mirroring all of it into React state would mean copying dozens of fields on
 * every event; instead a version counter forces a re-render and components read
 * from the live objects. That keeps the hot path (a track subscription
 * mid-call) to a single integer bump rather than a deep clone.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ConnectionState, Room, RoomEvent, Track } from 'livekit-client';
import { connectToRoom, E2EEUnsupportedError, ROOM_UPDATE_EVENTS } from './connect';
import { getConfig, joinRoom, ApiError } from '../lib/api';

export type RoomStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'left';

export interface RoomError {
  code: string;
  message: string;
  /** Whether retrying could plausibly succeed. */
  recoverable: boolean;
}

export interface UseRoomResult {
  room: Room | null;
  status: RoomStatus;
  error: RoomError | null;
  /** Bumps whenever LiveKit emits something that changes the rendered output. */
  version: number;
  connect: (displayName: string) => Promise<void>;
  leave: () => void;
}

export function useRoom(roomId: string, roomKey: string | null): UseRoomResult {
  const [status, setStatus] = useState<RoomStatus>('idle');
  const [error, setError] = useState<RoomError | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const roomRef = useRef<Room | null>(null);
  const connectingRef = useRef(false);

  const version = useRoomVersion(room);

  const leave = useCallback(() => {
    const current = roomRef.current;
    roomRef.current = null;
    setRoom(null);
    setStatus('left');
    void current?.disconnect();
  }, []);

  const connect = useCallback(
    async (displayName: string) => {
      // Double-invoked effects in StrictMode, and impatient double-clicks, must
      // not open two signaling sessions.
      if (connectingRef.current || roomRef.current) return;
      if (!roomKey) {
        setError({
          code: 'MISSING_KEY',
          message:
            'This meeting link is incomplete. Ask the organiser to resend the full link — the part after # holds the encryption key and cannot be recovered.',
          recoverable: false,
        });
        setStatus('failed');
        return;
      }

      connectingRef.current = true;
      setStatus('connecting');
      setError(null);

      try {
        const [config, credentials] = await Promise.all([
          getConfig(),
          joinRoom(roomId, displayName),
        ]);

        const connected = await connectToRoom({
          url: credentials.url,
          token: credentials.token,
          roomKey,
          config,
        });

        roomRef.current = connected;
        setRoom(connected);
        setStatus('connected');
      } catch (cause) {
        setError(toRoomError(cause));
        setStatus('failed');
        roomRef.current = null;
      } finally {
        connectingRef.current = false;
      }
    },
    [roomId, roomKey],
  );

  // Track LiveKit's own connection state so the UI can show a reconnect banner
  // rather than appearing frozen.
  useEffect(() => {
    if (!room) return;

    const onStateChange = (state: ConnectionState) => {
      switch (state) {
        case ConnectionState.Connected:
          setStatus('connected');
          break;
        case ConnectionState.Reconnecting:
          setStatus('reconnecting');
          break;
        case ConnectionState.Disconnected:
          setStatus((previous) => (previous === 'left' ? previous : 'failed'));
          break;
        default:
          break;
      }
    };

    const onDisconnected = () => {
      roomRef.current = null;
      setStatus((previous) => (previous === 'left' ? previous : 'left'));
    };

    room.on(RoomEvent.ConnectionStateChanged, onStateChange);
    room.on(RoomEvent.Disconnected, onDisconnected);
    return () => {
      room.off(RoomEvent.ConnectionStateChanged, onStateChange);
      room.off(RoomEvent.Disconnected, onDisconnected);
    };
  }, [room]);

  // Release the camera and microphone if the component unmounts for any reason.
  useEffect(
    () => () => {
      void roomRef.current?.disconnect();
      roomRef.current = null;
    },
    [],
  );

  return { room, status, error, version, connect, leave };
}

/**
 * Subscribes to every render-affecting LiveKit event and exposes a counter.
 * `useSyncExternalStore` guarantees React never renders a torn view of the
 * room during concurrent updates.
 */
function useRoomVersion(room: Room | null): number {
  const versionRef = useRef(0);

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!room) return () => undefined;
      const handler = () => {
        versionRef.current += 1;
        onChange();
      };
      for (const event of ROOM_UPDATE_EVENTS) room.on(event, handler);
      return () => {
        for (const event of ROOM_UPDATE_EVENTS) room.off(event, handler);
      };
    },
    [room],
  );

  return useSyncExternalStore(
    subscribe,
    () => versionRef.current,
    () => 0,
  );
}

function toRoomError(cause: unknown): RoomError {
  if (cause instanceof E2EEUnsupportedError) {
    return {
      code: 'E2EE_UNSUPPORTED',
      message:
        'This browser cannot encrypt media end-to-end. Please use a recent version of Chrome, Edge, Safari, or Firefox. NME will not connect without encryption.',
      recoverable: false,
    };
  }

  if (cause instanceof ApiError) {
    const recoverable = cause.code === 'NETWORK' || cause.code === 'TIMEOUT';
    return { code: cause.code, message: cause.message, recoverable };
  }

  if (cause instanceof Error && /permission|denied|NotAllowed/i.test(cause.message)) {
    return {
      code: 'DEVICE_PERMISSION',
      message: 'Camera or microphone access was blocked. Grant permission and try again.',
      recoverable: true,
    };
  }

  return {
    code: 'CONNECT_FAILED',
    message: 'Could not join the meeting. Please try again.',
    recoverable: true,
  };
}

/** Convenience accessor used by the grid and toolbar. */
export function screenShareTrack(room: Room) {
  for (const participant of [room.localParticipant, ...room.remoteParticipants.values()]) {
    const publication = participant.getTrackPublication(Track.Source.ScreenShare);
    if (publication?.track && !publication.isMuted) {
      return { participant, publication };
    }
  }
  return null;
}
