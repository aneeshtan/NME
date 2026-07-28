/**
 * Bottom control bar — the only chrome in the meeting.
 *
 * Four required controls plus an optional participants toggle. Every button is
 * a real <button> with an accessible name and a pressed state, so screen
 * readers announce "Microphone, on" rather than an unlabelled glyph.
 */
import type { ReactNode } from 'react';
import {
  CameraIcon,
  CameraOffIcon,
  LeaveIcon,
  MicIcon,
  MicOffIcon,
  PeopleIcon,
  ScreenShareIcon,
  ScreenShareStopIcon,
  SettingsIcon,
  ChatIcon,
  LayoutIcon,
} from '../components/icons';

interface Props {
  micEnabled: boolean;
  cameraEnabled: boolean;
  screenShareEnabled: boolean;
  screenShareAvailable: boolean;
  participantsOpen: boolean;
  participantCount: number;
  busy: boolean;
  settingsOpen: boolean;
  chatOpen: boolean;
  unreadCount: number;
  followSpeaker: boolean;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onToggleParticipants: () => void;
  onToggleSettings: () => void;
  onToggleChat: () => void;
  onToggleFollowSpeaker: () => void;
  onLeave: () => void;
  children?: ReactNode;
}

export function Toolbar({
  micEnabled,
  cameraEnabled,
  screenShareEnabled,
  screenShareAvailable,
  participantsOpen,
  participantCount,
  busy,
  settingsOpen,
  chatOpen,
  unreadCount,
  followSpeaker,
  onToggleMic,
  onToggleCamera,
  onToggleScreenShare,
  onToggleParticipants,
  onToggleSettings,
  onToggleChat,
  onToggleFollowSpeaker,
  onLeave,
  children,
}: Props) {
  return (
    <div className="pb-safe px-safe relative flex items-center justify-center gap-2 pt-3 max-[359px]:gap-1.5 sm:gap-3">
      {children}

      <ControlButton
        label={micEnabled ? 'Turn off microphone' : 'Turn on microphone'}
        pressed={!micEnabled}
        active={micEnabled}
        disabled={busy}
        onClick={onToggleMic}
        hint="Ctrl+D"
      >
        {micEnabled ? <MicIcon className="h-5 w-5" /> : <MicOffIcon className="h-5 w-5" />}
      </ControlButton>

      <ControlButton
        label={cameraEnabled ? 'Turn off camera' : 'Turn on camera'}
        pressed={!cameraEnabled}
        active={cameraEnabled}
        disabled={busy}
        onClick={onToggleCamera}
        hint="Ctrl+E"
      >
        {cameraEnabled ? (
          <CameraIcon className="h-5 w-5" />
        ) : (
          <CameraOffIcon className="h-5 w-5" />
        )}
      </ControlButton>

      {screenShareAvailable && (
        <ControlButton
          label={screenShareEnabled ? 'Stop presenting' : 'Present your screen'}
          pressed={screenShareEnabled}
          active={!screenShareEnabled}
          disabled={busy}
          onClick={onToggleScreenShare}
          accent={screenShareEnabled}
        >
          {screenShareEnabled ? (
            <ScreenShareStopIcon className="h-5 w-5" />
          ) : (
            <ScreenShareIcon className="h-5 w-5" />
          )}
        </ControlButton>
      )}

      <ControlButton
        label={`${participantsOpen ? 'Hide' : 'Show'} participants (${participantCount})`}
        pressed={participantsOpen}
        active
        onClick={onToggleParticipants}
      >
        <span className="relative">
          <PeopleIcon className="h-5 w-5" />
          <span className="absolute -top-2 -right-2.5 rounded-full bg-accent px-1.5 text-[0.625rem] leading-4 font-semibold text-white">
            {participantCount}
          </span>
        </span>
      </ControlButton>

      {/*
        Wrapped rather than given `hidden sm:inline-flex` directly: ControlButton
        already sets `inline-flex`, and two equal-specificity display rules are
        resolved by stylesheet order, so the `hidden` would be ignored.
      */}
      <span className="hidden sm:contents">
        <ControlButton
          label={followSpeaker ? 'Switch to grid view' : 'Switch to speaker view'}
          pressed={followSpeaker}
          active={!followSpeaker}
          accent={followSpeaker}
          onClick={onToggleFollowSpeaker}
        >
          <LayoutIcon className="h-5 w-5" />
        </ControlButton>
      </span>

      <ControlButton
        label={`${chatOpen ? 'Hide' : 'Show'} chat`}
        pressed={chatOpen}
        active
        onClick={onToggleChat}
      >
        <span className="relative">
          <ChatIcon className="h-5 w-5" />
          {unreadCount > 0 && (
            <span className="absolute -top-2 -right-2.5 rounded-full bg-accent px-1.5 text-[0.625rem] leading-4 font-semibold text-white">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </span>
      </ControlButton>

      <ControlButton
        label="Audio and video settings"
        pressed={settingsOpen}
        active
        onClick={onToggleSettings}
      >
        <SettingsIcon className="h-5 w-5" />
      </ControlButton>

      <button
        type="button"
        onClick={onLeave}
        aria-label="Leave meeting"
        className="tap-target ml-1 inline-flex items-center justify-center rounded-full bg-danger px-6 text-white transition-colors duration-150 hover:bg-danger-hover focus-visible:outline-2 max-[359px]:ml-0 max-[359px]:px-4"
      >
        <LeaveIcon className="h-5 w-5" />
      </button>
    </div>
  );
}

interface ControlButtonProps {
  label: string;
  pressed: boolean;
  active: boolean;
  disabled?: boolean;
  accent?: boolean;
  hint?: string;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}

function ControlButton({
  label,
  pressed,
  active,
  disabled = false,
  accent = false,
  hint,
  className = '',
  onClick,
  children,
}: ControlButtonProps) {
  // "Off" states are red because a muted mic is the single most consequential
  // piece of state in a meeting; it must be unmistakable at a glance.
  const tone = accent
    ? 'bg-accent text-white hover:bg-accent-hover'
    : active
      ? 'bg-elevated text-fg hover:bg-border'
      : 'bg-danger text-white hover:bg-danger-hover';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      title={hint ? `${label} (${hint})` : label}
      className={`tap-target inline-flex items-center justify-center rounded-full transition-colors duration-150 disabled:opacity-50 ${tone} ${className}`}
    >
      {children}
    </button>
  );
}
