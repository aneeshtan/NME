/**
 * Participant layout.
 *
 * Two modes, matching what people expect from a meeting app:
 *  - Grid: everyone equal, column count chosen to keep tiles near 16:9.
 *  - Presentation: the screen share takes the stage, everyone else becomes a
 *    filmstrip. Switching is automatic — nobody should have to find a button
 *    when someone starts sharing.
 */
import { useMemo, useRef } from 'react';
import type { Participant, Room } from 'livekit-client';
import { Track } from 'livekit-client';
import { VideoTile } from './VideoTile';
import { AudioSink } from './AudioSink';

/**
 * How many camera tiles the equal grid will render at once.
 *
 * Nine, because the cost that matters is not the SFU's — it is the receiver's.
 * Every rendered tile is a live video decode, and a phone or an older laptop
 * thermally throttles somewhere well short of the 25 a full room would produce.
 * `adaptiveStream` already pauses tracks whose elements are scrolled out of
 * view, which is why a narrow screen has always been fine; a desktop grid puts
 * every tile in the viewport at once, so nothing was paused and the ceiling was
 * the room's participant cap.
 *
 * Everyone beyond the ninth is still *heard* — see AudioSink — and still
 * reachable through pin and speaker view. Nine also happens to be the largest
 * count that stays a tidy 3x3.
 */
const MAX_VIDEO_TILES = 9;

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

  // Called before the early returns below, as every hook must be. Cheap when
  // the room is under the cap: it returns the input list unchanged.
  const { visible, overflow } = useVisibleParticipants(
    participants,
    speakingIds,
    MAX_VIDEO_TILES,
  );

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

  // Tile count drives the column count, and the overflow counter occupies one.
  const tileCount = visible.length + (overflow.length > 0 ? 1 : 0);
  const columns = columnsFor(tileCount);

  return (
    <>
      <div className="video-grid" data-columns={columns} data-count={tileCount}>
        {visible.map((participant) => (
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

        {overflow.length > 0 && <OverflowTile participants={overflow} />}
      </div>

      {/*
        The people who did not fit. Rendered as bare audio elements so they are
        still heard — see AudioSink on why that is not a detail.
      */}
      {overflow.map((participant) => {
        const mic = participant.getTrackPublication(Track.Source.Microphone);
        return (
          <AudioSink
            key={participant.sid}
            audioTrack={mic?.track}
            audioMuted={mic?.isMuted !== false}
          />
        );
      })}
    </>
  );
}

/**
 * Chooses which participants get a tile, and keeps that choice stable.
 *
 * The naive version — sort by who is talking, take the first nine — reshuffles
 * the grid on every utterance, which is unusable: tiles swap places while you
 * are looking at them. So the visible set is sticky. It changes only when
 * someone leaves, when a free slot opens, or when a participant who is speaking
 * is not on screen, in which case they displace the quietest tile that is.
 *
 * The local participant holds slot zero and is never displaced.
 */
function useVisibleParticipants(
  participants: Participant[],
  speakingIds: Set<string>,
  cap: number,
): { visible: Participant[]; overflow: Participant[] } {
  // Survives across renders so the previous choice can be honoured. Written
  // during the memo rather than in an effect: the result has to be consistent
  // with what this render returns, and an effect would apply it one frame late.
  const chosen = useRef<string[]>([]);

  return useMemo(() => {
    if (participants.length <= cap) {
      chosen.current = participants.map((p) => p.identity);
      return { visible: participants, overflow: [] };
    }

    const byIdentity = new Map(participants.map((p) => [p.identity, p]));

    // Anyone who left releases their slot.
    let kept = chosen.current.filter((id) => byIdentity.has(id));

    // Slot zero is the local participant — seeing yourself vanish because nine
    // other people spoke would read as a bug.
    const localIdentity = participants[0]?.identity;
    if (localIdentity) {
      kept = kept.filter((id) => id !== localIdentity);
      kept.unshift(localIdentity);
    }

    // Fill whatever is free, in join order.
    for (const participant of participants) {
      if (kept.length >= cap) break;
      if (!kept.includes(participant.identity)) kept.push(participant.identity);
    }
    kept = kept.slice(0, cap);

    // Promote active speakers who are off screen, displacing a silent tile.
    // Slot zero is skipped, so the local participant is never the one evicted.
    for (const identity of speakingIds) {
      if (kept.includes(identity) || !byIdentity.has(identity)) continue;
      const silent = kept.findIndex((id, index) => index > 0 && !speakingIds.has(id));
      if (silent === -1) break;
      kept[silent] = identity;
    }

    chosen.current = kept;
    const visibleSet = new Set(kept);

    return {
      visible: kept.map((id) => byIdentity.get(id)).filter((p): p is Participant => Boolean(p)),
      overflow: participants.filter((p) => !visibleSet.has(p.identity)),
    };
  }, [participants, speakingIds, cap]);
}

/** Stands in for everyone past the tile cap, so the count is never hidden. */
function OverflowTile({ participants }: { participants: Participant[] }) {
  const names = participants
    .slice(0, 8)
    .map((p) => p.name || 'Guest')
    .join(', ');

  return (
    <div
      className="video-tile flex flex-col items-center justify-center gap-1 rounded-xl bg-surface text-center"
      title={participants.length > 8 ? `${names}, and ${participants.length - 8} more` : names}
    >
      <span className="text-2xl font-semibold">+{participants.length}</span>
      <span className="px-2 text-xs leading-snug text-muted">
        more {participants.length === 1 ? 'person' : 'people'} — audible, not shown
      </span>
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
