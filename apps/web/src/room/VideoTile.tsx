/**
 * A single participant tile.
 *
 * Attaching a MediaStreamTrack to a <video> element is imperative DOM work that
 * React does not model, so it happens in an effect keyed on the track identity.
 * Detaching on cleanup is what prevents the decoder leak that shows up as
 * steadily climbing memory in long calls.
 */
import { memo, useEffect, useRef } from 'react';
import { Track } from 'livekit-client';
import { MicOffIcon } from '../components/icons';

/**
 * Every field here is a *value*, never a LiveKit object that carries mutable
 * state. That is deliberate and load-bearing: this component is memoised, and
 * LiveKit mutates `Participant` and `TrackPublication` in place — their
 * references never change when a camera is toggled or a track republished.
 * Reading that state during render would make `memo` compare identical props
 * and skip the re-render, so a participant enabling their camera mid-meeting
 * would simply never appear. Track identity and the muted flags are passed
 * explicitly so the comparison sees real changes.
 */
interface Props {
  isLocal: boolean;
  isSpeaking: boolean;
  name: string;
  videoTrack: Track | undefined;
  videoMuted: boolean;
  audioTrack: Track | undefined;
  audioMuted: boolean;
  /** Screen shares must not be mirrored or cropped. */
  source?: Track.Source;
}

export const VideoTile = memo(function VideoTile({
  isLocal,
  isSpeaking,
  name,
  videoTrack,
  videoMuted,
  audioTrack,
  audioMuted,
  source = Track.Source.Camera,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const isVideoLive = Boolean(videoTrack) && !videoMuted;
  const isScreenShare = source === Track.Source.ScreenShare;

  useEffect(() => {
    const element = videoRef.current;
    if (!element || !videoTrack || videoMuted) return;

    videoTrack.attach(element);
    return () => {
      videoTrack.detach(element);
    };
  }, [videoTrack, videoMuted]);

  useEffect(() => {
    const element = audioRef.current;
    // Local audio is never played back — doing so creates an echo loop.
    if (!element || isLocal) return;
    if (!audioTrack || audioMuted) return;

    audioTrack.attach(element);
    return () => {
      audioTrack.detach(element);
    };
  }, [audioTrack, audioMuted, isLocal]);

  const isMuted = audioMuted;

  return (
    <div
      // `h-full` is required, not decorative: the wrapper sets the tile's height
      // (via aspect-ratio on desktop, or the grid row on a phone), and a block
      // child does not inherit that — without it the tile collapses to its
      // content height.
      className={`group relative h-full overflow-hidden rounded-xl bg-surface transition-shadow duration-200 ${
        isSpeaking && !isScreenShare ? 'tile-speaking' : ''
      }`}
    >
      {isVideoLive ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          // Muted is mandatory for the local preview and harmless for remote
          // tiles, whose audio is routed through the dedicated <audio> element.
          muted
          className={`h-full w-full ${isScreenShare ? 'object-contain' : 'object-cover'} ${
            isLocal && !isScreenShare ? '-scale-x-100' : ''
          }`}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <Avatar name={name} />
        </div>
      )}

      {!isLocal && <audio ref={audioRef} autoPlay />}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-3 pt-8 pb-2.5">
        {isMuted && !isScreenShare && (
          <MicOffIcon className="h-3.5 w-3.5 shrink-0 text-white/90" />
        )}
        <span className="truncate text-[0.8125rem] font-medium text-white drop-shadow">
          {isScreenShare ? `${name} is presenting` : name}
          {isLocal && !isScreenShare ? ' (You)' : ''}
        </span>
      </div>
    </div>
  );
});

/** Initial-based placeholder, tinted deterministically from the name. */
function Avatar({ name }: { name: string }) {
  const initial = Array.from(name)[0]?.toUpperCase() ?? '?';
  // Cheap string hash — stable per name so a participant keeps one colour.
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const hue = hash % 360;

  return (
    <div
      // shrink-0 keeps it a circle: it is a flex item, and in a short or narrow
      // tile the default flex-shrink squashes it into an ellipse.
      className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-2xl font-semibold text-white sm:h-20 sm:w-20"
      // A single CSS custom property is the one inline style in the app; hue is
      // a number derived from a hash, so nothing user-controlled reaches CSS.
      style={{ backgroundColor: `oklch(0.55 0.13 ${hue})` }}
    >
      {initial}
    </div>
  );
}
