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
import { getConfig, joinRoom, claimKnock, ApiError, RelayUnavailableError } from '@nme/core';
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
 *
 * Shorter than LiveKit's 15s default: on a firewalled network the direct
 * attempt is hopeless, and this window is pure dead time before the connection
 * that will actually work. Long enough to absorb a slow mobile handshake.
 */
const DIRECT_CONNECT_TIMEOUT_MS = 8_000;

/** How often a waiting joiner asks whether they have been admitted. */
const KNOCK_POLL_MS = 2_000;
/** Give up after this long rather than waiting on a host who never returns. */
const KNOCK_TIMEOUT_MS = 5 * 60_000;

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
  /** True when media is travelling via a TURN relay rather than direct. */
  relayed: boolean;
  /** Bumps whenever LiveKit emits something that changes the rendered output. */
  version: number;
  connect: (displayName: string) => Promise<void>;
  leave: () => void;
}

export function useRoom(roomId: string, roomKey: string | null): UseRoomResult {
  const [status, setStatus] = useState<RoomStatus>('idle');
  const [error, setError] = useState<RoomError | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  // Surfaced in the UI: a participant is entitled to know their media is
  // travelling through a relay rather than straight to the SFU.
  const [relayed, setRelayed] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const connectingRef = useRef(false);

  const version = useRoomVersion(room);

  const leave = useCallback(() => {
    const current = roomRef.current;
    roomRef.current = null;
    setRoom(null);
    setStatus('left');
    // Cleared so a later rejoin from a different network cannot inherit a stale
    // "relayed" badge and misreport how the media is actually travelling.
    setRelayed(false);
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
        const [config, initial] = await Promise.all([
          getConfig(),
          // A stored host key admits the creator without knocking on their own
          // meeting; everyone else waits.
          joinRoom(roomId, displayName, {
            ...(loadHostKey(roomId) ? { hostKey: loadHostKey(roomId)! } : {}),
          }),
        ]);

        // Lobby room: no token yet. Poll until the host decides.
        let credentials: Awaited<ReturnType<typeof claimKnock>> | typeof initial = initial;
        if ('status' in initial && initial.status === 'waiting') {
          setStatus('waiting');
          credentials = await awaitAdmission(roomId, initial.knockId);
        }

        if ('status' in credentials && credentials.status === 'denied') {
          setError({
            code: 'DENIED',
            message: 'The host did not let you in.',
            recoverable: false,
          });
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

        const connectViaRelay = async (): Promise<Room> => {
          setStatus('relaying');

          // A fresh token is required, not an optimisation. The first token's
          // identity was already burned as a replay nonce the moment LiveKit
          // registered the participant, so reusing it would trip this app's own
          // replay defence and get the retry evicted.
          const relayCredentials = await joinRoom(roomId, displayName, {
            relay: true,
            ...(loadHostKey(roomId) ? { hostKey: loadHostKey(roomId)! } : {}),
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

          const relayed = await connectToRoom({
            url: relayCredentials.url,
            token: relayCredentials.token,
            roomKey,
            config,
            iceServers: relayCredentials.iceServers,
          });

          setRelayed(true);
          return relayed;
        };

        let connected: Room;

        if (forceRelay()) {
          // Skips the direct attempt entirely — see `forceRelay` below.
          connected = await connectViaRelay();
        } else {
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
            // A media-path failure is recoverable via relay; anything else (bad
            // token, room full, unsupported browser) would fail identically on
            // the second attempt, so it is rethrown rather than retried.
            if (!isMediaPathFailure(directFailure)) throw directFailure;
            connected = await connectViaRelay();
          }
        }

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

  return { room, status, error, relayed, version, connect, leave };
}

/**
 * `?relay=1` forces the relay path and skips the direct attempt.
 *
 * The relay only engages on networks that block direct media, which are
 * precisely the networks you cannot get onto in order to test it. So the one
 * code path that exists for people in difficulty is the one that never gets
 * exercised, and breaks unnoticed. This flag makes it reachable from an
 * ordinary desk.
 *
 * Safe to leave in production: it can only make a connection *more*
 * restricted, never less, and the credentials it requests are the same
 * short-lived ones any struggling participant would receive. The badge in the
 * meeting still reports honestly that media is being relayed.
 *
 * Read from the query string rather than the fragment, which belongs entirely
 * to the room key.
 */
function forceRelay(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('relay') === '1';
  } catch {
    return false;
  }
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
 * Distinguishes "the media path is blocked" from failures a relay cannot fix.
 *
 * Retrying the wrong class of error would double every genuine failure's
 * latency and issue relay credentials to clients that have no use for them.
 * E2EE support and API-level rejections (room full, invalid name, rate limit)
 * are deterministic — they will fail the same way on a second attempt.
 */
/**
 * Polls until the host admits, denies, or the joiner gives up.
 *
 * Polling is the honest option here: pushing a verdict would require the
 * waiting client to already hold a connection into the room, which is exactly
 * what the lobby is withholding.
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

function isMediaPathFailure(cause: unknown): boolean {
  if (cause instanceof E2EEUnsupportedError) return false;
  if (cause instanceof ApiError) return false;

  // Permission denial is a local device problem; no transport change helps.
  if (cause instanceof Error && /permission|denied|NotAllowed/i.test(cause.message)) {
    return false;
  }

  // LiveKit surfaces a blocked media path as a connection/timeout error once
  // the peer connection budget elapses. Anything else unrecognised is treated
  // as retryable: a spurious relay attempt costs one request, whereas failing
  // to retry strands the user this feature exists to serve.
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
