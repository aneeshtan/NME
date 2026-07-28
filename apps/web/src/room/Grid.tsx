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
  reactions: { identity: string; emoji: string }[];
  raisedHands: Set<string>;
  /** Identity to feature, or null for the equal grid. */
  pinnedIdentity: string | null;
  /** When true, the loudest speaker is featured unless something is pinned. */
  followSpeaker: boolean;
  onPin: (identity: string | null) => void;
}

export function Grid({
  room,
  version,
  screenShare,
  reactions,
  raisedHands,
  pinnedIdentity,
  followSpeaker,
  onPin,
}: Props) {
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

  /**
   * Who gets the stage. An explicit pin always wins over the active speaker:
   * having the layout jump away from the person you deliberately focused on,
   * every time someone else coughs, is worse than no speaker view at all.
   */
  const featured = useMemo(() => {
    if (pinnedIdentity) {
      return participants.find((p) => p.identity === pinnedIdentity) ?? null;
    }
    if (!followSpeaker) return null;
    const speaker = room.activeSpeakers[0];
    // Falling back to the last featured participant would need extra state;
    // the local participant is a stable, sensible stage when nobody is talking.
    return speaker ?? participants[0] ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participants, pinnedIdentity, followSpeaker, room, version]);

  if (!screenShare && featured) {
    return (
      <Featured
        room={room}
        featured={featured}
        others={participants}
        speakingIds={speakingIds}
        onPin={onPin}
        pinnedIdentity={pinnedIdentity}
        reactions={reactions}
        raisedHands={raisedHands}
      />
    );
  }

  if (screenShare) {
    return (
      <div className="flex h-full w-full flex-col gap-2 lg:flex-row">
        <div className="min-h-0 flex-1">
          <VideoTile
            {...tileState(screenShare.participant, Track.Source.ScreenShare)}
            isLocal={screenShare.participant === room.localParticipant}
            isSpeaking={false}
          />
        </div>
        <div className="flex shrink-0 gap-2 overflow-x-auto lg:h-full lg:w-52 lg:flex-col lg:overflow-x-hidden lg:overflow-y-auto">
          {participants.map((participant) => (
            <div
              key={participant.sid}
              className="aspect-video w-32 shrink-0 lg:w-full"
            >
              <VideoTile
                {...tileState(participant, Track.Source.Camera, { reactions, raisedHands })}
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
    <div className="video-grid" data-columns={columns} data-count={participants.length}>
      {participants.map((participant) => (
        <button
          key={participant.sid}
          type="button"
          onClick={() => onPin(participant.identity)}
          title={`Pin ${participant.name || 'Guest'}`}
          className="video-tile cursor-pointer text-left"
        >
          <VideoTile
            {...tileState(participant, Track.Source.Camera, { reactions, raisedHands })}
            isLocal={participant === room.localParticipant}
            isSpeaking={speakingIds.has(participant.identity)}
          />
        </button>
      ))}
    </div>
  );
}

/**
 * Reads a participant's mutable LiveKit state into plain values for the tile.
 *
 * This runs on every version bump, which is exactly what makes the memoised
 * tile correct: LiveKit mutates participants and publications in place, so the
 * only way `memo` can observe a camera being toggled is if the changed values
 * arrive as new props.
 */
function tileState(
  participant: Participant,
  source: Track.Source = Track.Source.Camera,
  overlays?: { reactions: { identity: string; emoji: string }[]; raisedHands: Set<string> },
) {
  const videoPublication = participant.getTrackPublication(source);
  const micPublication = participant.getTrackPublication(Track.Source.Microphone);

  return {
    name: participant.name || 'Guest',
    videoTrack: videoPublication?.track,
    // Absent publication means nothing is being sent — treated as muted.
    videoMuted: videoPublication?.isMuted !== false,
    audioTrack: micPublication?.track,
    audioMuted: micPublication?.isMuted !== false,
    handRaised: overlays?.raisedHands.has(participant.identity) ?? false,
    reaction:
      overlays?.reactions.find((r) => r.identity === participant.identity)?.emoji ?? null,
    source,
  };
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

/**
 * Stage-plus-filmstrip layout, shared by pin and speaker view.
 *
 * Deliberately the same arrangement as screen sharing: one large surface with
 * everyone else along the edge is already the shape people recognise from
 * presenting, so focusing a person needs no new visual vocabulary.
 */
function Featured({
  room,
  featured,
  others,
  speakingIds,
  onPin,
  pinnedIdentity,
  reactions,
  raisedHands,
}: {
  room: Room;
  featured: Participant;
  others: Participant[];
  speakingIds: Set<string>;
  onPin: (identity: string | null) => void;
  pinnedIdentity: string | null;
  reactions: { identity: string; emoji: string }[];
  raisedHands: Set<string>;
}) {
  return (
    <div className="flex h-full w-full flex-col gap-2 lg:flex-row">
      <button
        type="button"
        onClick={() => onPin(null)}
        title={pinnedIdentity ? 'Unpin' : 'Back to grid'}
        className="min-h-0 flex-1 cursor-pointer text-left"
      >
        <VideoTile
          {...tileState(featured, Track.Source.Camera, { reactions, raisedHands })}
          isLocal={featured === room.localParticipant}
          isSpeaking={speakingIds.has(featured.identity)}
        />
      </button>

      <div className="flex shrink-0 gap-2 overflow-x-auto lg:h-full lg:w-52 lg:flex-col lg:overflow-x-hidden lg:overflow-y-auto">
        {others
          .filter((participant) => participant.identity !== featured.identity)
          .map((participant) => (
            <button
              key={participant.sid}
              type="button"
              onClick={() => onPin(participant.identity)}
              title={`Pin ${participant.name || 'Guest'}`}
              className="aspect-video w-32 shrink-0 cursor-pointer text-left lg:w-full"
            >
              <VideoTile
                {...tileState(participant, Track.Source.Camera, { reactions, raisedHands })}
                isLocal={participant === room.localParticipant}
                isSpeaking={speakingIds.has(participant.identity)}
              />
            </button>
          ))}
      </div>
    </div>
  );
}
