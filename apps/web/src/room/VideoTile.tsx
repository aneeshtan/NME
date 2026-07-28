/**
 * A single participant tile.
 *
 * Attaching a MediaStreamTrack to a <video> element is imperative DOM work that
 * React does not model, so it happens in an effect keyed on the track identity.
 * Detaching on cleanup is what prevents the decoder leak that shows up as
 * steadily climbing memory in long calls.
 */
import { memo, useEffect, useRef } from 'react';
import type { Participant } from 'livekit-client';
import { Track } from 'livekit-client';
import { MicOffIcon } from '../components/icons';

interface Props {
  participant: Participant;
  isLocal: boolean;
  isSpeaking: boolean;
  /** Screen shares must not be mirrored or cropped. */
  source?: Track.Source;
}

export const VideoTile = memo(function VideoTile({
  participant,
  isLocal,
  isSpeaking,
  source = Track.Source.Camera,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const videoPublication = participant.getTrackPublication(source);
  const micPublication = participant.getTrackPublication(Track.Source.Microphone);

  const videoTrack = videoPublication?.track;
  const isVideoLive = Boolean(videoTrack) && videoPublication?.isMuted === false;
  const isScreenShare = source === Track.Source.ScreenShare;

  useEffect(() => {
    const element = videoRef.current;
    if (!element || !videoTrack || videoPublication?.isMuted !== false) return;

    videoTrack.attach(element);
    return () => {
      videoTrack.detach(element);
    };
  }, [videoTrack, videoPublication?.isMuted]);

  useEffect(() => {
    const element = audioRef.current;
    // Local audio is never played back — doing so creates an echo loop.
    if (!element || isLocal) return;
    const audioTrack = micPublication?.track;
    if (!audioTrack || micPublication?.isMuted !== false) return;

    audioTrack.attach(element);
    return () => {
      audioTrack.detach(element);
    };
  }, [micPublication?.track, micPublication?.isMuted, isLocal]);

  const name = participant.name || 'Guest';
  const isMuted = micPublication?.isMuted !== false;

  return (
    <div
      className={`group relative overflow-hidden rounded-xl bg-surface transition-shadow duration-200 ${
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
      className="flex h-16 w-16 items-center justify-center rounded-full text-2xl font-semibold text-white sm:h-20 sm:w-20"
      // A single CSS custom property is the one inline style in the app; hue is
      // a number derived from a hash, so nothing user-controlled reaches CSS.
      style={{ backgroundColor: `oklch(0.55 0.13 ${hue})` }}
    >
      {initial}
    </div>
  );
}
