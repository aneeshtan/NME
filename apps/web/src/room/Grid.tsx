/**
 * Participant layout.
 *
 * Two modes, matching what people expect from a meeting app:
 *  - Grid: everyone equal, column count chosen to keep tiles near 16:9.
 *  - Presentation: the screen share takes the stage, everyone else becomes a
 *    filmstrip. Switching is automatic — nobody should have to find a button
 *    when someone starts sharing.
 */
import { useMemo } from 'react';
import type { Participant, Room } from 'livekit-client';
import { Track } from 'livekit-client';
import { VideoTile } from './VideoTile';

interface Props {
  room: Room;
  /** Forces a recompute when LiveKit state changes; see useRoom. */
  version: number;
  screenShare: { participant: Participant } | null;
}

export function Grid({ room, version, screenShare }: Props) {
  const participants = useMemo(
    () => [room.localParticipant, ...room.remoteParticipants.values()],
    // `version` is the dependency that matters: the arrays above are mutated in
    // place by LiveKit, so identity alone would never signal a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room, version],
  );

  const speakingIds = useMemo(
    () => new Set(room.activeSpeakers.map((speaker) => speaker.identity)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [room, version],
  );

  if (screenShare) {
    return (
      <div className="flex h-full w-full flex-col gap-2 lg:flex-row">
        <div className="min-h-0 flex-1">
          <VideoTile
            participant={screenShare.participant}
            isLocal={screenShare.participant === room.localParticipant}
            isSpeaking={false}
            source={Track.Source.ScreenShare}
          />
        </div>
        <div className="flex shrink-0 gap-2 overflow-x-auto lg:h-full lg:w-52 lg:flex-col lg:overflow-x-hidden lg:overflow-y-auto">
          {participants.map((participant) => (
            <div
              key={participant.sid}
              className="aspect-video w-32 shrink-0 lg:w-full"
            >
              <VideoTile
                participant={participant}
                isLocal={participant === room.localParticipant}
                isSpeaking={speakingIds.has(participant.identity)}
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const columns = columnsFor(participants.length);

  return (
    <div className="video-grid" data-columns={columns}>
      {participants.map((participant) => (
        <div key={participant.sid} className="aspect-video min-h-0 w-full">
          <VideoTile
            participant={participant}
            isLocal={participant === room.localParticipant}
            isSpeaking={speakingIds.has(participant.identity)}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Column count that keeps the grid close to square overall, which maximises how
 * large each 16:9 tile can be inside the available area.
 */
function columnsFor(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  if (count <= 16) return 4;
  return 5;
}
