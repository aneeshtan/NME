/**
 * Meeting page: pre-join → connected → left.
 *
 * Lazy-loaded, so the ~200 KB LiveKit client and the E2EE worker are fetched
 * only when someone actually opens a meeting. The home page never pays for them.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConnectionQuality } from 'livekit-client';
import { PreJoin } from '../room/PreJoin';
import { Grid } from '../room/Grid';
import { Toolbar } from '../room/Toolbar';
import { Participants } from '../room/Participants';
import { useRoom, screenShareTrack } from '../room/useRoom';
import { useDevices } from '../room/useDevices';
import { useWakeLock } from '../room/useWakeLock';
import { useAudioOnly } from '../room/useAudioOnly';
import { DeviceMenu } from '../room/DeviceMenu';
import { buildMeetingUrl, readRoomKeyFromUrl } from '../lib/e2ee';
import { loadDevicePrefs, saveDevicePrefs, saveDisplayName } from '../lib/storage';
import { Logo } from '../components/Logo';
import { CopyLinkButton } from '../components/CopyLinkButton';
import { ShieldIcon, SignalIcon } from '../components/icons';
import { navigate } from '../lib/router';

interface Props {
  roomId: string;
}

export default function Meeting({ roomId }: Props) {
  // Read once on mount: the fragment must not be re-read after navigation, and
  // it is the one value the server can never supply.
  const roomKey = useMemo(() => readRoomKeyFromUrl(window.location.hash), []);
  const meetingUrl = useMemo(
    () => (roomKey ? buildMeetingUrl(window.location.origin, roomId, roomKey) : ''),
    [roomId, roomKey],
  );

  const { room, status, error, relayed, version, connect, leave } = useRoom(roomId, roomKey);

  const [prefs, setPrefs] = useState(loadDevicePrefs);
  const [joined, setJoined] = useState(false);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [audioOnly, setAudioOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  const deviceState = useDevices(room);
  // Only hold the screen awake while actually in a call.
  useWakeLock(status === 'connected');
  useAudioOnly(room, audioOnly);

  useEffect(() => saveDevicePrefs(prefs), [prefs]);

  const handleJoin = useCallback(
    async (displayName: string) => {
      saveDisplayName(displayName);
      setJoined(true);
      await connect(displayName);
    },
    [connect],
  );

  // Publish the initial device state once the room is live. Doing it here
  // rather than at connect time means a denied permission surfaces as a muted
  // button, not a failed join.
  useEffect(() => {
    if (status !== 'connected' || !room) return;
    let cancelled = false;

    void (async () => {
      try {
        if (prefs.micEnabled) await room.localParticipant.setMicrophoneEnabled(true);
        if (!cancelled && prefs.cameraEnabled) {
          await room.localParticipant.setCameraEnabled(true);
        }
      } catch {
        if (!cancelled) setPrefs({ micEnabled: false, cameraEnabled: false });
      }
    })();

    return () => {
      cancelled = true;
    };
    // Intentionally runs once per connection, not on every pref change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, room]);

  const toggleMic = useCallback(async () => {
    if (!room) {
      setPrefs((current) => ({ ...current, micEnabled: !current.micEnabled }));
      return;
    }
    setBusy(true);
    try {
      const next = !room.localParticipant.isMicrophoneEnabled;
      await room.localParticipant.setMicrophoneEnabled(next);
      setPrefs((current) => ({ ...current, micEnabled: next }));
    } finally {
      setBusy(false);
    }
  }, [room]);

  const toggleCamera = useCallback(async () => {
    if (!room) {
      setPrefs((current) => ({ ...current, cameraEnabled: !current.cameraEnabled }));
      return;
    }
    setBusy(true);
    try {
      const next = !room.localParticipant.isCameraEnabled;
      await room.localParticipant.setCameraEnabled(next);
      setPrefs((current) => ({ ...current, cameraEnabled: next }));
    } finally {
      setBusy(false);
    }
  }, [room]);

  const toggleScreenShare = useCallback(async () => {
    if (!room) return;
    setBusy(true);
    try {
      const next = !room.localParticipant.isScreenShareEnabled;
      // Include system audio when the browser offers it — sharing a video with
      // no sound is a recurring frustration in every other tool.
      await room.localParticipant.setScreenShareEnabled(next, { audio: true });
    } catch {
      // The user dismissed the picker; nothing to report.
    } finally {
      setBusy(false);
    }
  }, [room]);

  const handleLeave = useCallback(() => {
    leave();
    setJoined(false);
  }, [leave]);

  // Google Meet's shortcuts, which is what people already have in their fingers.
  useEffect(() => {
    if (status !== 'connected') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === 'd') {
        event.preventDefault();
        void toggleMic();
      } else if (key === 'e') {
        event.preventDefault();
        void toggleCamera();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [status, toggleMic, toggleCamera]);

  if (status === 'left') {
    return <LeftScreen roomId={roomId} meetingUrl={meetingUrl} />;
  }

  // Detected up front rather than after the user fills in their name: without
  // the key there is no way to join, and discovering that only on submit wastes
  // their time and hides the actual problem behind a generic failure.
  if (!roomKey) {
    return (
      <FatalError
        message="This meeting link is incomplete. The part after # carries the encryption key, and without it the call cannot be decrypted. Ask the organiser to resend the full link."
      />
    );
  }

  if (error && !error.recoverable) {
    return <FatalError message={error.message} />;
  }

  if (!joined || status === 'idle' || (status === 'failed' && error?.recoverable)) {
    return (
      <>
        {error?.recoverable && (
          <div
            role="alert"
            className="bg-danger px-4 py-2.5 text-center text-sm font-medium text-white"
          >
            {error.message}
          </div>
        )}
        <PreJoin
          roomId={roomId}
          meetingUrl={meetingUrl}
          connecting={status === 'connecting'}
          micEnabled={prefs.micEnabled}
          cameraEnabled={prefs.cameraEnabled}
          onToggleMic={() => void toggleMic()}
          onToggleCamera={() => void toggleCamera()}
          onJoin={(name) => void handleJoin(name)}
        />
      </>
    );
  }

  if (!room || status === 'connecting' || status === 'relaying') {
    return <Connecting relaying={status === 'relaying'} />;
  }

  const screenShare = screenShareTrack(room);
  const participantCount = room.remoteParticipants.size + 1;
  const quality = qualityLevel(room.localParticipant.connectionQuality);

  return (
    <div className="flex h-full flex-col">
      {status === 'reconnecting' && (
        <div
          role="status"
          className="bg-accent px-4 py-2 text-center text-sm font-medium text-white"
        >
          Reconnecting…
        </div>
      )}

      {quality <= 2 && status === 'connected' && (
        // Shown only while degraded, and placed with the other status banners
        // rather than in the toolbar: a status glyph should never compete with
        // tap targets for width on a narrow phone.
        <div
          role="status"
          className={`flex items-center justify-center gap-1.5 px-4 py-1.5 text-center text-xs font-medium text-white ${
            quality === 0 ? 'bg-danger' : 'bg-amber-600'
          }`}
        >
          <SignalIcon level={quality} className="h-3.5 w-3.5 shrink-0" />
          <span>
            {quality === 0
              ? 'Connection lost — trying to reconnect'
              : 'Weak connection — video quality reduced'}
          </span>
        </div>
      )}

      {relayed && status === 'connected' && (
        // Disclosure, not a warning: the call is still end-to-end encrypted and
        // the relay cannot read it, but a participant should know a third party
        // is carrying their traffic.
        <div
          role="status"
          className="flex items-center justify-center gap-1.5 bg-elevated px-4 py-1.5 text-center text-xs text-muted"
        >
          <ShieldIcon className="h-3.5 w-3.5 shrink-0" />
          <span>
            Connected via relay — your network blocked a direct connection. Still end-to-end
            encrypted.
          </span>
        </div>
      )}

      {/* `relative` anchors the participants overlay on small screens. */}
      <div className="relative flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 p-2 sm:p-3">
          <Grid
            room={room}
            version={version}
            screenShare={screenShare ? { participant: screenShare.participant } : null}
          />
        </main>

        {participantsOpen && (
          <Participants
            room={room}
            version={version}
            meetingUrl={meetingUrl}
            onClose={() => setParticipantsOpen(false)}
          />
        )}
      </div>

      <footer className="shrink-0">
        <Toolbar
          micEnabled={room.localParticipant.isMicrophoneEnabled}
          cameraEnabled={room.localParticipant.isCameraEnabled}
          screenShareEnabled={room.localParticipant.isScreenShareEnabled}
          screenShareAvailable={supportsScreenShare()}
          participantsOpen={participantsOpen}
          participantCount={participantCount}
          busy={busy}
          settingsOpen={settingsOpen}
          onToggleMic={() => void toggleMic()}
          onToggleCamera={() => void toggleCamera()}
          onToggleScreenShare={() => void toggleScreenShare()}
          onToggleParticipants={() => setParticipantsOpen((open) => !open)}
          onToggleSettings={() => setSettingsOpen((open) => !open)}
          onLeave={handleLeave}
        >
          {settingsOpen && (
            <DeviceMenu
              state={deviceState}
              audioOnly={audioOnly}
              onToggleAudioOnly={() => setAudioOnly((on) => !on)}
              onClose={() => setSettingsOpen(false)}
            />
          )}
        </Toolbar>
      </footer>
    </div>
  );
}

/**
 * Maps LiveKit's quality enum onto signal bars. Unknown is treated as good:
 * quality is not reported until a few seconds of stats exist, and flashing a
 * warning during every join would train people to ignore it.
 */
function qualityLevel(quality: ConnectionQuality): number {
  switch (quality) {
    case ConnectionQuality.Excellent:
      return 4;
    case ConnectionQuality.Good:
      return 3;
    case ConnectionQuality.Poor:
      return 2;
    case ConnectionQuality.Lost:
      return 0;
    default:
      return 3;
  }
}

/** getDisplayMedia is absent on iOS Safari; hide the control rather than fail. */
function supportsScreenShare(): boolean {
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

function Connecting({ relaying = false }: { relaying?: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-border border-t-accent" />
      <p className="text-sm text-muted" role="status">
        {relaying ? 'Your network is restricted — connecting via relay…' : 'Joining meeting…'}
      </p>
    </div>
  );
}

function FatalError({ message }: { message: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
      <ShieldIcon className="h-9 w-9 text-danger" />
      <p className="max-w-md text-[0.9375rem] leading-relaxed" role="alert">
        {message}
      </p>
      <button
        type="button"
        onClick={() => navigate('/')}
        className="rounded-xl border border-border px-5 py-2.5 text-sm font-medium hover:bg-surface"
      >
        Back to home
      </button>
    </div>
  );
}

function LeftScreen({ roomId, meetingUrl }: { roomId: string; meetingUrl: string }) {
  return (
    <div className="flex h-full flex-col">
      <header className="pt-safe px-5 pb-5 sm:px-8">
        <Logo />
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 pb-20 text-center">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">You left the meeting</h1>
          <p className="mt-2 text-sm text-muted">
            Meeting <span className="font-mono">{roomId}</span>
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent-hover"
          >
            Rejoin
          </button>
          {meetingUrl && <CopyLinkButton url={meetingUrl} />}
          <button
            type="button"
            onClick={() => navigate('/')}
            className="rounded-xl border border-border px-5 py-2.5 text-sm font-medium hover:bg-surface"
          >
            Home
          </button>
        </div>
      </div>
    </div>
  );
}
