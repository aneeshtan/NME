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
import { decodeRoomKey } from '../lib/e2ee';
import type { ClientConfig } from '../lib/api';

export interface ConnectParams {
  url: string;
  token: string;
  roomKey: string;
  config: ClientConfig;
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

  // The key must be installed before connecting; otherwise the first inbound
  // frames arrive with no decryptor and are dropped. Raw bytes are passed
  // through rather than a string, so no text encoding can corrupt the key.
  await keyProvider.setKey(decodeRoomKey(params.roomKey));
  await room.setE2EEEnabled(true);

  await room.connect(params.url, params.token, buildConnectOptions());
  return room;
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

      // Screen shares are mostly static text; prioritise sharpness over motion.
      screenShareEncoding: {
        maxBitrate: 2_500_000,
        maxFramerate: 5,
        priority: 'high',
      },
      backupCodec: false,
    },

    // Recover a dropped connection instead of forcing a full rejoin.
    reconnectPolicy: {
      nextRetryDelayInMs: (context) =>
        context.retryCount > 8 ? null : Math.min(300 * 2 ** context.retryCount, 8_000),
    },

    stopLocalTrackOnUnpublish: true,
  };
}

function buildConnectOptions(): RoomConnectOptions {
  return {
    autoSubscribe: true,
    /**
     * Start negotiating before the ICE gathering completes. Shaves a noticeable
     * slice off join time on networks where STUN is slow to answer.
     */
    rtcConfig: {
      // The SFU supplies its own ICE servers (including TURN credentials) over
      // the authenticated signaling channel. Hard-coding public STUN servers
      // here would leak participants' IP addresses to a third party for no gain.
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
    },
    maxRetries: 3,
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
