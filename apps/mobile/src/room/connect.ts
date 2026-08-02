/**
 * Room construction and E2EE setup for the native clients.
 *
 * Deliberately a close mirror of the web client's `room/connect.ts`. The two
 * must agree on codec, simulcast layers, and above all on key derivation — a
 * divergence in any of them produces a call that connects, reports itself
 * healthy, and shows nothing but frozen tiles.
 *
 * The one structural difference is where encryption happens. On the web,
 * frames pass through a Web Worker running LiveKit's JavaScript cryptor. Here
 * there is no worker and no insertable-streams API; encryption happens inside
 * libwebrtc's native frame cryptor instead. Same AES-GCM, same derived key,
 * different execution environment — which is why `e2ee` is configured with an
 * `e2eeManager` rather than a `worker`.
 */
import { RNE2EEManager, RNKeyProvider } from '@livekit/react-native';
import { Room, RoomEvent, VideoPresets, type RoomConnectOptions, type RoomOptions } from 'livekit-client';
import { mediaPassphrase, type ClientConfig, type IceServerConfig } from '@nme/core';

export interface ConnectParams {
  url: string;
  token: string;
  roomKey: string;
  config: ClientConfig;
  /**
   * Relay servers, supplied only on a fallback attempt. Their presence also
   * switches ICE into relay-only mode.
   */
  iceServers?: IceServerConfig[];
  /** Budget for the peer connection to establish before giving up. */
  peerConnectionTimeoutMs?: number;
}

/**
 * Builds and connects a Room with E2EE mandatory.
 *
 * As on the web, there is no unencrypted fallback. A phone that could not
 * encrypt would be a phone whose owner believes the call is private while the
 * server can read it.
 */
export async function connectToRoom(params: ConnectParams): Promise<Room> {
  const keyProvider = new RNKeyProvider({
    sharedKey: true,
    /**
     * Ratcheting off, matching `ExternalE2EEKeyProvider` on the web.
     *
     * The room key comes from the link and never changes for the life of the
     * meeting, so there is nothing to ratchet towards. Leaving the window open
     * would only mean that a peer sending garbage causes every client to burn
     * CPU deriving keys that cannot help.
     */
    ratchetWindowSize: 0,
    failureTolerance: -1,
  });

  const e2eeManager = new RNE2EEManager(keyProvider);
  const room = new Room(buildRoomOptions(params.config, e2eeManager));

  try {
    /**
     * Keep the base64url invitation string intact. LiveKit's native and web
     * providers both treat this as a UTF-8 passphrase and apply PBKDF2. Passing
     * decoded bytes selects a different derivation in the browser.
     */
    await keyProvider.setSharedKey(mediaPassphrase(params.roomKey));
    await room.setE2EEEnabled(true);

    await room.connect(params.url, params.token, buildConnectOptions(params));
    return room;
  } catch (error) {
    // A failed attempt is followed by a relay retry, so everything this one
    // allocated has to go — including the native cryptor holding the key.
    await room.disconnect().catch(() => undefined);
    keyProvider.dispose();
    throw error;
  }
}

function buildRoomOptions(config: ClientConfig, e2eeManager: RNE2EEManager): RoomOptions {
  return {
    e2ee: { e2eeManager },

    /**
     * Subscribe at the resolution actually being displayed. This matters more
     * on a phone than anywhere else: the tiles are small, the radio is the
     * biggest consumer of battery in the device, and every pixel decoded that
     * nobody sees is paid for twice, in data and in heat.
     */
    adaptiveStream: true,
    dynacast: true,

    videoCaptureDefaults: {
      // 720p from the front camera of a modern phone is already more than a
      // grid tile can show; asking for more would spend uplink on nothing.
      resolution: VideoPresets.h720.resolution,
      facingMode: 'user',
    },

    audioCaptureDefaults: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },

    publishDefaults: {
      /**
       * Simulcast, and specifically compatible with E2EE: the SFU picks among
       * encrypted layers rather than re-encoding, so it never needs the key.
       */
      simulcast: true,
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
      videoCodec: config.videoCodec,
      videoEncoding: VideoPresets.h720.encoding,

      dtx: true,
      red: true,
      audioPreset: { maxBitrate: 24_000 },
      backupCodec: false,
    },

    /**
     * Reconnect budget of roughly two minutes, matching the web.
     *
     * Mobile needs it more, not less. Walking out of Wi-Fi range onto cellular
     * breaks every connection the device holds; a short budget would turn an
     * ordinary walk to the car park into a dropped meeting.
     */
    reconnectPolicy: {
      nextRetryDelayInMs: (context) =>
        context.retryCount > 15 ? null : Math.min(300 * 2 ** context.retryCount, 10_000),
    },

    stopLocalTrackOnUnpublish: true,
  };
}

function buildConnectOptions(params: ConnectParams): RoomConnectOptions {
  const relaying = (params.iceServers?.length ?? 0) > 0;

  return {
    autoSubscribe: true,

    rtcConfig: {
      // Unset on the direct attempt, so the SFU's own ICE configuration
      // applies and no third-party STUN server learns the user's address.
      ...(relaying ? { iceServers: params.iceServers as RTCIceServer[] } : {}),
      iceTransportPolicy: relaying ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
    },

    ...(params.peerConnectionTimeoutMs
      ? { peerConnectionTimeout: params.peerConnectionTimeoutMs }
      : {}),

    maxRetries: relaying ? 3 : 0,
  };
}

/** Events that change what the UI must render. */
export const ROOM_UPDATE_EVENTS = [
  RoomEvent.ParticipantConnected,
  RoomEvent.ParticipantDisconnected,
  RoomEvent.TrackSubscribed,
  RoomEvent.TrackUnsubscribed,
  RoomEvent.TrackPublished,
  RoomEvent.TrackUnpublished,
  RoomEvent.TrackMuted,
  RoomEvent.TrackUnmuted,
  RoomEvent.LocalTrackPublished,
  RoomEvent.LocalTrackUnpublished,
  RoomEvent.ActiveSpeakersChanged,
  RoomEvent.ConnectionStateChanged,
  RoomEvent.ParticipantNameChanged,
] as const;
