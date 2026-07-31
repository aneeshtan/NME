/**
 * Room lifecycle as a React hook.
 *
 * The twin of `apps/web/src/room/useRoom.ts`, and intentionally so: the join
 * sequence — knock, wait for admission, try direct, fall back to relay — is the
 * part of this app with the most ways to be subtly wrong, and the two clients
 * have to make the same decisions or a meeting will admit one and not the
 * other. Changes to the sequence belong in both files.
 *
 * Two differences, both forced by the platform:
 *   - The host key is read asynchronously, because AsyncStorage is.
 *   - There is no E2EE-unsupported case. On the web a browser may lack
 *     insertable streams; here the frame cryptor is compiled into the binary,
 *     so if the app runs at all, it can encrypt.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AudioSession } from '@livekit/react-native';
import { ConnectionState, Room, RoomEvent } from 'livekit-client';
import {
  ApiError,
  claimKnock,
  getConfig,
  joinRoom,
  RelayUnavailableError,
} from '@nme/core';
import { connectToRoom, ROOM_UPDATE_EVENTS } from './connect';
import { loadHostKey } from '../lib/storage';

export type RoomStatus =
  | 'idle'
  | 'connecting'
  /** Knocked on a lobby room; waiting for someone inside to admit us. */
  | 'waiting'
  /** Direct media failed; establishing a relayed connection instead. */
  | 'relaying'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'left';

/**
 * How long to wait for a direct media path before falling back to the relay.
 * Generous enough for a slow cellular handshake, short enough that a user on a
 * firewalled corporate Wi-Fi is not left watching a spinner.
 */
const DIRECT_CONNECT_TIMEOUT_MS = 8_000;

const KNOCK_POLL_MS = 2_000;
const KNOCK_TIMEOUT_MS = 5 * 60_000;

export interface RoomError {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface UseRoomResult {
  room: Room | null;
  status: RoomStatus;
  error: RoomError | null;
  /** True when media is travelling via a TURN relay rather than direct. */
  relayed: boolean;
  version: number;
  connect: (displayName: string) => Promise<void>;
  leave: () => void;
}

export function useRoom(roomId: string, roomKey: string | null): UseRoomResult {
  const [status, setStatus] = useState<RoomStatus>('idle');
  const [error, setError] = useState<RoomError | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [relayed, setRelayed] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const connectingRef = useRef(false);

  const version = useRoomVersion(room);

  const leave = useCallback(() => {
    const current = roomRef.current;
    roomRef.current = null;
    setRoom(null);
    setStatus('left');
    setRelayed(false);
    void current?.disconnect();
    // Hands the audio route back to the system. Skipping this leaves the phone
    // in call mode — media from other apps stays quiet and routed to the
    // earpiece until something else claims the session.
    void AudioSession.stopAudioSession();
  }, []);

  const connect = useCallback(
    async (displayName: string) => {
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
        /**
         * Claims the audio route before any track is published. Doing it after
         * connecting means the first second of the call plays through the
         * wrong output on iOS, which sounds like a broken app rather than a
         * timing detail.
         */
        await AudioSession.startAudioSession();

        const hostKey = await loadHostKey(roomId);
        const [config, initial] = await Promise.all([
          getConfig(),
          joinRoom(roomId, displayName, hostKey ? { hostKey } : {}),
        ]);

        let credentials: Awaited<ReturnType<typeof claimKnock>> | typeof initial = initial;
        if ('status' in initial && initial.status === 'waiting') {
          setStatus('waiting');
          credentials = await awaitAdmission(roomId, initial.knockId);
        }

        if ('status' in credentials && credentials.status === 'denied') {
          setError({ code: 'DENIED', message: 'The host did not let you in.', recoverable: false });
          setStatus('failed');
          return;
        }
        if (!('token' in credentials)) {
          setError({
            code: 'NO_ANSWER',
            message: 'Nobody answered your request to join. Try again later.',
            recoverable: true,
          });
          setStatus('failed');
          return;
        }
        setStatus('connecting');

        let connected: Room;
        try {
          // Attempt 1: direct. No relay credentials are requested or held, so
          // on a normal network no third party is ever contacted.
          connected = await connectToRoom({
            url: credentials.url,
            token: credentials.token,
            roomKey,
            config,
            peerConnectionTimeoutMs: DIRECT_CONNECT_TIMEOUT_MS,
          });
        } catch (directFailure) {
          if (!isMediaPathFailure(directFailure)) throw directFailure;

          setStatus('relaying');

          // A fresh token, not an optimisation: the first token's identity was
          // burned as a replay nonce the moment LiveKit registered the
          // participant, so reusing it would trip this app's own replay
          // defence and get the retry evicted.
          const relayCredentials = await joinRoom(roomId, displayName, {
            relay: true,
            ...(hostKey ? { hostKey } : {}),
          });

          if (!('token' in relayCredentials) || !relayCredentials.iceServers?.length) {
            /**
             * The server issued no relay credentials, so there is nothing left
             * to try. Rethrowing the direct failure here would report this as
             * an ordinary "could not connect, try again" — which is actively
             * misleading, because retrying on this network will fail every
             * time. The remedy is to configure a relay, and only a distinct
             * error can say so.
             */
            throw new RelayUnavailableError();
          }

          connected = await connectToRoom({
            url: relayCredentials.url,
            token: relayCredentials.token,
            roomKey,
            config,
            iceServers: relayCredentials.iceServers,
          });

          setRelayed(true);
        }

        roomRef.current = connected;
        setRoom(connected);
        setStatus('connected');
      } catch (cause) {
        setError(toRoomError(cause));
        setStatus('failed');
        roomRef.current = null;
        void AudioSession.stopAudioSession();
      } finally {
        connectingRef.current = false;
      }
    },
    [roomId, roomKey],
  );

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
      void AudioSession.stopAudioSession();
    };

    room.on(RoomEvent.ConnectionStateChanged, onStateChange);
    room.on(RoomEvent.Disconnected, onDisconnected);
    return () => {
      room.off(RoomEvent.ConnectionStateChanged, onStateChange);
      room.off(RoomEvent.Disconnected, onDisconnected);
    };
  }, [room]);

  // Release the camera, microphone, and audio session if this unmounts for any
  // reason. On a phone a leaked camera shows as a recording indicator the user
  // cannot explain, which reads as spyware.
  useEffect(
    () => () => {
      void roomRef.current?.disconnect();
      roomRef.current = null;
      void AudioSession.stopAudioSession();
    },
    [],
  );

  return { room, status, error, relayed, version, connect, leave };
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

/**
 * Polls until the host admits, denies, or the joiner gives up.
 *
 * Polling is the honest option: pushing a verdict would require the waiting
 * client to already hold a connection into the room, which is precisely what
 * the lobby is withholding.
 */
async function awaitAdmission(
  roomId: string,
  knockId: string,
): Promise<Awaited<ReturnType<typeof claimKnock>>> {
  const deadline = Date.now() + KNOCK_TIMEOUT_MS;

  for (;;) {
    const verdict = await claimKnock(roomId, knockId);
    if (verdict.status !== 'waiting') return verdict;
    if (Date.now() > deadline) return { status: 'waiting' };
    await new Promise((resolve) => setTimeout(resolve, KNOCK_POLL_MS));
  }
}

/**
 * Distinguishes "the media path is blocked" from failures a relay cannot fix.
 * Retrying the wrong class of error would double every genuine failure's
 * latency and hand relay credentials to clients with no use for them.
 */
function isMediaPathFailure(cause: unknown): boolean {
  if (cause instanceof ApiError) return false;
  if (cause instanceof Error && /permission|denied|NotAllowed/i.test(cause.message)) return false;
  return true;
}

function toRoomError(cause: unknown): RoomError {
  if (cause instanceof RelayUnavailableError) {
    return {
      code: 'RELAY_UNAVAILABLE',
      message:
        'This network is blocking the direct connection to the meeting server, ' +
        'and no relay is available to work around it. Ask the organiser to ' +
        'enable a TURN relay, or join from a different network.',
      // Retrying on this network cannot succeed, so do not invite it.
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
      message:
        'Camera or microphone access was blocked. Enable them for NME Talk in Settings and try again.',
      recoverable: true,
    };
  }

  return {
    code: 'CONNECT_FAILED',
    message: 'Could not join the meeting. Please try again.',
    recoverable: true,
  };
}
