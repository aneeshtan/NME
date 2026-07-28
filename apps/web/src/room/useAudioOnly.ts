/**
 * Audio-only mode.
 *
 * Unsubscribes from every remote video track, which is the one "feature" here
 * that makes the app cheaper rather than more expensive: the SFU stops
 * forwarding those streams entirely, so it saves downstream bandwidth, decode
 * work, and battery. Useful on a metered or weak connection, and on a phone
 * where video decode is the dominant power draw.
 *
 * Note this is receive-side only — the local camera keeps publishing, so others
 * still see you. Turning your own camera off is a separate, explicit action.
 */
import { useEffect } from 'react';
import { RoomEvent, Track, type RemoteTrackPublication, type Room } from 'livekit-client';

export function useAudioOnly(room: Room | null, enabled: boolean): void {
  useEffect(() => {
    if (!room) return;

    const applyTo = (publication: RemoteTrackPublication) => {
      if (publication.kind !== Track.Kind.Video) return;
      publication.setSubscribed(!enabled);
    };

    const applyAll = () => {
      for (const participant of room.remoteParticipants.values()) {
        for (const publication of participant.trackPublications.values()) {
          applyTo(publication as RemoteTrackPublication);
        }
      }
    };

    applyAll();

    // Anyone who joins or starts their camera later must inherit the setting,
    // otherwise audio-only silently lapses as the meeting goes on.
    const onPublished = (publication: RemoteTrackPublication) => applyTo(publication);

    room.on(RoomEvent.TrackPublished, onPublished);
    room.on(RoomEvent.ParticipantConnected, applyAll);

    return () => {
      room.off(RoomEvent.TrackPublished, onPublished);
      room.off(RoomEvent.ParticipantConnected, applyAll);
    };
  }, [room, enabled]);
}
