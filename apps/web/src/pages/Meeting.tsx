/**
 * Meeting page: pre-join → connected → left.
 *
 * Lazy-loaded, so the ~200 KB LiveKit client and the E2EE worker are fetched
 * only when someone actually opens a meeting. The home page never pays for them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Chat } from '../room/Chat';
import { useMessaging } from '../room/useMessaging';
import { useMutedSpeechDetector } from '../room/useMutedSpeechDetector';
import { usePresenceAlerts } from '../room/usePresenceAlerts';
import { useBackgroundBlur } from '../room/useBackgroundBlur';
import { useKnocks } from '../room/useKnocks';
import { useBackgroundNotice } from '../room/useBackgroundNotice';
import { useSpeakingTime } from '../room/useSpeakingTime';
import { REACTIONS } from '@nme/core';
import { buildShortMeetingUrl, deriveRoomId, readRoomKeyFromAnyUrl } from '@nme/core';
import { loadDevicePrefs, saveDevicePrefs, saveDisplayName, loadHostKey } from '../lib/storage';
import { Logo } from '../components/Logo';
import { CopyLinkButton } from '../components/CopyLinkButton';
import { ShieldIcon, SignalIcon } from '../components/icons';
import { navigate } from '../lib/router';

interface Props {
  /** Null on a short link, where the id is derived from the key instead. */
  roomId: string | null;
}

export default function Meeting({ roomId: routeRoomId }: Props) {
  // Read once on mount: the fragment must not be re-read after navigation, and
  // it is the one value the server can never supply.
  const roomKey = useMemo(() => readRoomKeyFromAnyUrl(window.location.hash), []);

  // Short links carry only the key, so the id is derived here. Deriving is a
  // hash, so it resolves in a millisecond — but it is async, hence the state.
  const [derivedRoomId, setDerivedRoomId] = useState<string | null>(routeRoomId);
  useEffect(() => {
    if (routeRoomId || !roomKey) return;
    let cancelled = false;
    void deriveRoomId(roomKey).then((id) => {
      if (!cancelled) setDerivedRoomId(id);
    });
    return () => {
      cancelled = true;
    };
  }, [routeRoomId, roomKey]);

  const roomId = derivedRoomId ?? '';
  const meetingUrl = useMemo(
    () => (roomKey ? buildShortMeetingUrl(window.location.origin, roomKey) : ''),
    [roomKey],
  );

  const { room, status, error, relayed, version, connect, leave } = useRoom(roomId, roomKey);

  const [prefs, setPrefs] = useState(loadDevicePrefs);
  const [joined, setJoined] = useState(false);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [audioOnly, setAudioOnly] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [pinnedIdentity, setPinnedIdentity] = useState<string | null>(null);
  const [followSpeaker, setFollowSpeaker] = useState(false);
  const [warnWhenMuted, setWarnWhenMuted] = useState(false);
  const [reactionsOpen, setReactionsOpen] = useState(false);
  const [presenceSound, setPresenceSound] = useState(true);
  const [busy, setBusy] = useState(false);

  const hostKey = useMemo(() => loadHostKey(roomId), [roomId]);
  // Anyone in the meeting can admit, so the local identity is the credential
  // for everyone who is not the creator. It stops working the moment they leave.
  const knocks = useKnocks(
    roomId,
    { hostKey, identity: room?.localParticipant.identity ?? null },
    status === 'connected',
  );

  const speaking = useSpeakingTime(room, status === 'connected');

  const deviceState = useDevices(room);

  // Someone asked us to mute: honoured locally rather than enforced remotely.
  const handleMuteRequest = useCallback(() => {
    void room?.localParticipant.setMicrophoneEnabled(false);
    setPrefs((current) => ({ ...current, micEnabled: false }));
  }, [room]);

  const messaging = useMessaging(room, roomKey, chatOpen, handleMuteRequest);

  /**
   * Alerts for the two things that happen to you while you are looking at a
   * different tab: someone arrives at the lobby, or someone says something.
   * Both are invisible otherwise — a backgrounded tab paints nothing and is
   * frequently muted, so the on-screen notice and the chime both miss.
   */
  const notice = useBackgroundNotice();
  const waitingCount = knocks.pending.length;
  const lastWaiting = useRef(0);
  const lastUnread = useRef(0);

  useEffect(() => {
    if (waitingCount > lastWaiting.current) {
      const latest = knocks.pending[knocks.pending.length - 1]?.displayName;
      notice.notify({
        tag: 'nme-knock',
        title:
          waitingCount === 1 && latest
            ? `${latest} is waiting to join`
            : `${waitingCount} people are waiting to join`,
      });
    }
    lastWaiting.current = waitingCount;
  }, [waitingCount, knocks.pending, notice]);

  useEffect(() => {
    if (messaging.unread > lastUnread.current) {
      // No body: the sender's words were encrypted specifically to stay off
      // screens like a lock screen, which is exactly where this can appear.
      notice.notify({ tag: 'nme-chat', title: 'New message in the meeting' });
    }
    lastUnread.current = messaging.unread;
  }, [messaging.unread, notice]);
  // Only hold the screen awake while actually in a call.
  useWakeLock(status === 'connected');
  useAudioOnly(room, audioOnly);

  const notices = usePresenceAlerts(room, presenceSound);
  const blur = useBackgroundBlur(room, room?.localParticipant.isCameraEnabled ?? false);

  const micLive = room?.localParticipant.isMicrophoneEnabled ?? false;
  const speakingWhileMuted = useMutedSpeechDetector(
    warnWhenMuted && status === 'connected' && !micLive,
    deviceState.selected.audioinput,
  );

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

  // Waiting on the one-millisecond hash before anything can be done with the id.
  if (!derivedRoomId && roomKey) {
    return <Connecting />;
  }

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

  if (status === 'waiting') {
    return <WaitingForApproval roomId={roomId} />;
  }

  if (!room || status === 'connecting' || status === 'relaying') {
    return <Connecting relaying={status === 'relaying'} />;
  }

  const screenShare = screenShareTrack(room);
  const participantCount = room.remoteParticipants.size + 1;
  const quality = qualityLevel(room.localParticipant.connectionQuality);

  return (
    <div className="relative flex h-full flex-col">
      {status === 'reconnecting' && (
        <div
          role="status"
          className="bg-accent px-4 py-2 text-center text-sm font-medium text-white"
        >
          Reconnecting…
        </div>
      )}

      {knocks.pending.length > 0 && (
        <div className="absolute inset-x-0 top-2 z-40 flex flex-col items-center gap-2 px-3">
          {knocks.pending.map((knock) => (
            <div
              key={knock.id}
              role="alert"
              className="flex w-full max-w-md items-center gap-3 rounded-xl border border-border bg-elevated px-3 py-2.5 shadow-xl"
            >
              <span className="min-w-0 flex-1 truncate text-sm">
                <span className="font-semibold">{knock.displayName}</span> wants to join
              </span>
              <button
                type="button"
                onClick={() => void knocks.deny(knock.id)}
                className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface hover:text-fg"
              >
                Deny
              </button>
              <button
                type="button"
                onClick={() => void knocks.admit(knock.id)}
                className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-hover"
              >
                Admit
              </button>
            </div>
          ))}
        </div>
      )}

      {notices.length > 0 && (
        <div
          aria-live="polite"
          className="pointer-events-none absolute inset-x-0 top-2 z-30 flex flex-col items-center gap-1"
        >
          {notices.map((notice) => (
            <span
              key={notice.id}
              className="rounded-full bg-elevated/95 px-3 py-1 text-xs font-medium shadow-lg"
            >
              {notice.text}
            </span>
          ))}
        </div>
      )}

      {speakingWhileMuted && (
        <div
          role="status"
          className="bg-amber-600 px-4 py-2 text-center text-sm font-semibold text-white"
        >
          Your microphone is off — nobody can hear you
        </div>
      )}

      {messaging.muteRequestFrom && (
        <div
          role="status"
          className="flex items-center justify-center gap-3 bg-elevated px-4 py-2 text-center text-sm"
        >
          <span>{messaging.muteRequestFrom} asked you to mute — your mic is now off.</span>
          <button
            type="button"
            onClick={messaging.clearMuteRequest}
            className="shrink-0 text-xs font-semibold text-accent underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {messaging.timeboxEndsAt !== null && (
        <TimeboxBanner
          endsAt={messaging.timeboxEndsAt}
          onClear={() => void messaging.setTimebox(null)}
        />
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
            reactions={messaging.reactions}
            raisedHands={messaging.raisedHands}
            pinnedIdentity={pinnedIdentity}
            followSpeaker={followSpeaker}
            onPin={setPinnedIdentity}
          />
        </main>

        {participantsOpen && (
          <Participants
            room={room}
            version={version}
            roomKey={roomKey}
            meetingUrl={meetingUrl}
            speaking={speaking}
            onAskToMute={(identity) => void messaging.askToMute(identity)}
            onClose={() => setParticipantsOpen(false)}
          />
        )}

        {chatOpen && <Chat messaging={messaging} onClose={() => setChatOpen(false)} />}
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
          chatOpen={chatOpen}
          handRaised={messaging.handRaised}
          reactionsOpen={reactionsOpen}
          unreadCount={messaging.unread}
          followSpeaker={followSpeaker}
          onToggleMic={() => void toggleMic()}
          onToggleCamera={() => void toggleCamera()}
          onToggleScreenShare={() => void toggleScreenShare()}
          onToggleParticipants={() => setParticipantsOpen((open) => !open)}
          onToggleSettings={() => setSettingsOpen((open) => !open)}
          onToggleChat={() => setChatOpen((open) => !open)}
          onToggleHand={() => void messaging.toggleHand()}
          onToggleReactions={() => setReactionsOpen((open) => !open)}
          onToggleFollowSpeaker={() => {
            setFollowSpeaker((on) => !on);
            // Leaving a stale pin behind would make the toggle appear inert.
            setPinnedIdentity(null);
          }}
          onLeave={handleLeave}
        >
          {reactionsOpen && (
            <div
              role="dialog"
              aria-label="Send a reaction"
              className="absolute bottom-full left-1/2 z-30 mb-3 flex -translate-x-1/2 gap-1 rounded-full border border-border bg-elevated px-2 py-1.5 shadow-xl"
            >
              {REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={`React with ${emoji}`}
                  onClick={() => {
                    void messaging.sendReaction(emoji);
                    setReactionsOpen(false);
                  }}
                  className="tap-target inline-flex items-center justify-center rounded-full text-xl transition-transform hover:scale-125"
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}

          {settingsOpen && (
            <DeviceMenu
              state={deviceState}
              audioOnly={audioOnly}
              onToggleAudioOnly={() => setAudioOnly((on) => !on)}
              warnWhenMuted={warnWhenMuted}
              onToggleWarnWhenMuted={() => setWarnWhenMuted((on) => !on)}
              presenceSound={presenceSound}
              onTogglePresenceSound={() => setPresenceSound((on) => !on)}
              blur={blur}
              onSetTimebox={(endsAt) => {
                void messaging.setTimebox(endsAt);
                setSettingsOpen(false);
              }}
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

/**
 * Shared countdown.
 *
 * The clock belongs to the meeting rather than to whoever set it: the end time
 * is broadcast, so everyone sees the same number and nobody has to be the one
 * watching it.
 */
function TimeboxBanner({ endsAt, onClear }: { endsAt: number; onClear: () => void }) {
  const [remaining, setRemaining] = useState(endsAt - Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setRemaining(endsAt - Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [endsAt]);

  const over = remaining <= 0;
  const seconds = Math.max(0, Math.round(Math.abs(remaining) / 1000));
  const label = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  return (
    <div
      role="status"
      className={`flex items-center justify-center gap-3 px-4 py-1.5 text-center text-xs font-medium ${
        over ? 'bg-amber-600 text-white' : 'bg-elevated text-muted'
      }`}
    >
      <span>{over ? `Over time by ${label}` : `${label} remaining`}</span>
      <button type="button" onClick={onClear} className="shrink-0 underline">
        Clear
      </button>
    </div>
  );
}

function WaitingForApproval({ roomId }: { roomId: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-border border-t-accent" />
      <div>
        <p className="text-[0.9375rem] font-medium" role="status">
          Waiting for someone to let you in
        </p>
        <p className="mt-1.5 text-sm text-muted">
          Meeting <span className="font-mono">{roomId}</span>
        </p>
      </div>
    </div>
  );
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
