/**
 * Participants panel. Optional surface, kept to a list and a copy-link action.
 */
import type { Room } from 'livekit-client';
import { Track } from 'livekit-client';
import { CloseIcon, MicOffIcon } from '../components/icons';
import { CopyLinkButton } from '../components/CopyLinkButton';

interface Props {
  room: Room;
  version: number;
  meetingUrl: string;
  onClose: () => void;
}

export function Participants({ room, version, meetingUrl, onClose }: Props) {
  void version; // Re-render trigger; state is read from the live Room below.
  const participants = [room.localParticipant, ...room.remoteParticipants.values()];

  return (
    <aside
      /*
       * A full-width side panel inside a flex row would crush the video area on
       * a phone, so below `sm` it becomes an overlay instead and the grid keeps
       * its full width underneath.
       */
      className="absolute inset-0 z-20 flex h-full w-full flex-col bg-surface sm:static sm:z-auto sm:w-72 sm:border-l sm:border-border"
      aria-label="Participants"
    >
      <header className="flex items-center justify-between px-4 py-3.5">
        <h2 className="text-sm font-semibold">People ({participants.length})</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close participants panel"
          className="tap-target -mr-2 inline-flex items-center justify-center rounded-full text-muted hover:text-fg"
        >
          <CloseIcon className="h-4.5 w-4.5" />
        </button>
      </header>

      <ul className="flex-1 overflow-y-auto px-2 pb-2">
        {participants.map((participant) => {
          const mic = participant.getTrackPublication(Track.Source.Microphone);
          const isMuted = mic?.isMuted !== false;
          const isLocal = participant === room.localParticipant;

          return (
            <li
              key={participant.sid}
              className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm"
            >
              <span className="min-w-0 flex-1 truncate">
                {participant.name || 'Guest'}
                {isLocal && <span className="text-muted"> (You)</span>}
              </span>
              {isMuted && (
                <MicOffIcon className="h-4 w-4 shrink-0 text-muted" aria-label="Muted" />
              )}
            </li>
          );
        })}
      </ul>

      <footer className="border-t border-border p-3">
        <CopyLinkButton url={meetingUrl} className="w-full" />
        <p className="mt-2 px-1 text-[0.6875rem] leading-relaxed text-muted">
          The link contains this meeting&rsquo;s encryption key. Share it only with people you
          want in the call.
        </p>
      </footer>
    </aside>
  );
}
