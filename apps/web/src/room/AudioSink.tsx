/**
 * A participant's audio with no tile attached to it.
 *
 * The grid renders only a bounded number of video tiles, and audio is attached
 * *inside* those tiles — so without this, the people who did not fit on screen
 * would go silent. That is the failure mode this component exists to prevent,
 * and it is worth stating plainly: capping video is a rendering decision, and
 * it must never become a decision about who can be heard.
 *
 * Audio is cheap in a way video is not. Opus with DTX sends almost nothing
 * while someone is listening, so subscribing to every participant's audio in a
 * fifty-person room costs a fraction of what one extra video decode does.
 */
import { memo, useEffect, useRef } from 'react';
import type { Track } from 'livekit-client';

interface Props {
  audioTrack: Track | undefined;
  audioMuted: boolean;
}

export const AudioSink = memo(function AudioSink({ audioTrack, audioMuted }: Props) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || !audioTrack || audioMuted) return;

    audioTrack.attach(element);
    // Detaching on cleanup is what stops the decoder leak that otherwise shows
    // up as steadily climbing memory across a long meeting.
    return () => {
      audioTrack.detach(element);
    };
  }, [audioTrack, audioMuted]);

  return <audio ref={ref} autoPlay />;
});
