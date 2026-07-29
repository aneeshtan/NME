/**
 * LiveKit room construction, E2EE setup, and publishing defaults.
 *
 * Isolated from React so the media logic can be reasoned about — and tested —
 * without a component tree.
 */
import {
  ExternalE2EEKeyProvider,
  Room,
  RoomEvent,
  VideoPresets,
  isE2EESupported,
  type RoomConnectOptions,
  type RoomOptions,
} from 'livekit-client';
import { decodeRoomKey } from '@nme/core';
import type { ClientConfig, IceServerConfig } from '@nme/core';

export interface ConnectParams {
  url: string;
  token: string;
  roomKey: string;
  config: ClientConfig;
  /**
   * Relay servers, supplied only on a fallback attempt. Their presence also
   * switches ICE into relay-only mode — see `buildConnectOptions`.
   */
  iceServers?: IceServerConfig[];
  /** Budget for the peer connection to establish before giving up. */
  peerConnectionTimeoutMs?: number;
}

export class E2EEUnsupportedError extends Error {
  constructor() {
    super('This browser cannot encrypt media end-to-end.');
    this.name = 'E2EEUnsupportedError';
  }
}

/**
 * Builds and connects a Room with E2EE mandatory.
 *
 * There is deliberately no unencrypted fallback. Silently downgrading when
 * Insertable Streams are unavailable would mean some participants believe the
 * call is private while the server can read it — a worse outcome than refusing
 * to connect.
 */
export async function connectToRoom(params: ConnectParams): Promise<Room> {
  if (!isE2EESupported()) {
    throw new E2EEUnsupportedError();
  }

  const keyProvider = new ExternalE2EEKeyProvider();

  // Vite compiles this into a same-origin chunk, satisfying `worker-src 'self'`.
  // Frame encryption runs here, off the main thread, so it never competes with
  // rendering — the single biggest factor in perceived call smoothness.
  const worker = new Worker(new URL('livekit-client/e2ee-worker', import.meta.url), {
    type: 'module',
  });

  const room = new Room(buildRoomOptions(params.config, keyProvider, worker));

  try {
    // The key must be installed before connecting; otherwise the first inbound
    // frames arrive with no decryptor and are dropped. Raw bytes are passed
    // through rather than a string, so no text encoding can corrupt the key.
    await keyProvider.setKey(decodeRoomKey(params.roomKey));
    await room.setE2EEEnabled(true);

    await room.connect(params.url, params.token, buildConnectOptions(params));
    return room;
  } catch (error) {
    // A failed attempt is followed by a relay retry, so everything this one
    // allocated has to go. Without terminating the worker explicitly, each
    // retry would strand a live Web Worker holding the room key.
    await room.disconnect().catch(() => undefined);
    worker.terminate();
    throw error;
  }
}

function buildRoomOptions(
  config: ClientConfig,
  keyProvider: ExternalE2EEKeyProvider,
  worker: Worker,
): RoomOptions {
  return {
    e2ee: { keyProvider, worker },

    /**
     * Subscribe at the resolution actually being displayed. A 12-person grid
     * renders ~180p tiles, so pulling 720p for each would waste roughly 10x the
     * bandwidth and decode budget for pixels nobody sees.
     */
    adaptiveStream: true,

    /**
     * Stop publishing layers no one is subscribed to. With everyone in grid
     * view, the 720p simulcast layer is pure waste — this reclaims the uplink
     * and the encoder cycles that produce it.
     */
    dynacast: true,

    disconnectOnPageLeave: true,

    videoCaptureDefaults: {
      resolution: VideoPresets.h720.resolution,
      facingMode: 'user',
    },

    audioCaptureDefaults: {
      // Browser-native DSP: far cheaper and better tuned than anything we could
      // run in userland, and it is what makes a laptop mic usable in a room.
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },

    publishDefaults: {
      /**
       * Simulcast: publish 180p/360p/720p so the SFU can forward the layer each
       * receiver can afford, without transcoding. This is what lets one weak
       * participant avoid degrading the call for everyone — and critically, it
       * is compatible with E2EE, because the SFU selects among encrypted layers
       * rather than re-encoding them.
       */
      simulcast: true,
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
      videoCodec: config.videoCodec,
      videoEncoding: VideoPresets.h720.encoding,

      // Opus DTX: stop sending packets during silence. Meaningful savings in a
      // meeting, where most participants are listening most of the time.
      dtx: true,
      red: true,
      audioPreset: { maxBitrate: 24_000 },

      /**
       * Screen share favours sharpness over frame rate — text has to stay
       * legible. 15fps rather than the 5fps that suits purely static slides:
       * scrolling a document or playing a video at 5fps reads as broken, and
       * the bitrate ceiling still keeps this well below a camera stream.
       */
      screenShareEncoding: {
        maxBitrate: 2_500_000,
        maxFramerate: 15,
        priority: 'high',
      },
      backupCodec: false,
    },

    // Recover a dropped connection instead of forcing a full rejoin.
    /**
     * Reconnect budget: roughly two minutes of exponential backoff.
     *
     * Deliberately generous. Across a long meeting a transient break is not
     * unusual — a laptop sleeping, a handover from Wi-Fi to cellular, a VPN
     * renegotiating, a brief ISP blip. A short budget turns any of those into a
     * dropped call that the participant has to rejoin manually, which is far
     * more disruptive than continuing to retry in the background.
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
      /**
       * On the direct attempt this is left unset, so the SFU's own ICE
       * configuration applies. No public STUN servers are hard-coded — that
       * would leak every participant's IP to a third party for no gain.
       *
       * On the relay attempt the server-issued credentials are injected here.
       * livekit-client gives a caller-supplied `rtcConfig.iceServers`
       * precedence over what the SFU advertises.
       */
      ...(relaying ? { iceServers: params.iceServers as RTCIceServer[] } : {}),

      /**
       * Relay-only on the fallback. Direct paths have already been tried and
       * failed, so re-gathering them would just repeat a known-lost race before
       * the relay candidate wins.
       *
       * It also improves privacy for the participant who needs it: with
       * `relay`, every candidate they advertise belongs to the relay, so their
       * real IP address is never exposed to other participants.
       */
      iceTransportPolicy: relaying ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
    },

    /**
     * The direct attempt gets a short budget so a blocked network fails fast
     * and reaches the relay quickly, rather than leaving the user watching a
     * spinner for the 15s default.
     */
    ...(params.peerConnectionTimeoutMs
      ? { peerConnectionTimeout: params.peerConnectionTimeoutMs }
      : {}),

    // No retries on the direct attempt: a retry here just delays the fallback
    // that is actually going to work.
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
  RoomEvent.ConnectionQualityChanged,
  RoomEvent.ParticipantNameChanged,
] as const;
