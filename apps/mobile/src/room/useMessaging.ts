/**
 * Encrypted chat over the data channel.
 *
 * LiveKit's E2EE covers media frames only; data-channel payloads are encrypted
 * hop-by-hop, which means the SFU can read them. So messages carry their own
 * AES-GCM envelope keyed from the room secret — see `messaging.ts` in
 * @nme/core, which both clients share so that a phone and a browser in the
 * same meeting can actually read each other.
 *
 * Nothing is stored. Someone joining late sees an empty thread, which is the
 * honest consequence of keeping no server-side record.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { RoomEvent, type Participant, type Room } from 'livekit-client';
import { deriveChatKey, openMessage, sealMessage } from '@nme/core';

export interface DisplayedMessage {
  id: string;
  senderName: string;
  isLocal: boolean;
  at: number;
  text: string;
}

/** Bounded so a long meeting cannot grow the list without limit. */
const MAX_MESSAGES = 300;

export interface Messaging {
  messages: DisplayedMessage[];
  unread: number;
  sendChat: (text: string) => Promise<void>;
  markRead: () => void;
}

export function useMessaging(room: Room | null, roomKey: string, chatOpen: boolean): Messaging {
  const [messages, setMessages] = useState<DisplayedMessage[]>([]);
  const [unread, setUnread] = useState(0);
  const keyRef = useRef<CryptoKey | null>(null);
  const counterRef = useRef(0);

  // `chatOpen` is read through a ref so that toggling the panel does not tear
  // down and re-establish the room subscription below.
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;

  useEffect(() => {
    let cancelled = false;
    void deriveChatKey(roomKey).then((key) => {
      if (!cancelled) keyRef.current = key;
    });
    return () => {
      cancelled = true;
      keyRef.current = null;
    };
  }, [roomKey]);

  useEffect(() => {
    if (!room) return;

    const onData = (payload: Uint8Array, participant?: Participant) => {
      const key = keyRef.current;
      if (!key) return;

      void openMessage(key, payload).then((message) => {
        // Null covers both a failed authentication and a message shape this
        // build does not know — a browser peer sending a poll, say. Dropping
        // it silently is correct: an older client must not crash on a newer
        // one's traffic.
        if (!message || message.type !== 'chat') return;

        counterRef.current += 1;
        setMessages((previous) =>
          [
            ...previous,
            {
              id: `m${counterRef.current}`,
              senderName: participant?.name || 'Guest',
              isLocal: false,
              at: message.at,
              text: message.text,
            },
          ].slice(-MAX_MESSAGES),
        );
        if (!chatOpenRef.current) setUnread((count) => count + 1);
      });
    };

    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room]);

  const sendChat = useCallback(
    async (text: string) => {
      const key = keyRef.current;
      const trimmed = text.trim();
      if (!room || !key || !trimmed) return;

      const at = Date.now();
      const sealed = await sealMessage(key, { type: 'chat', at, text: trimmed });
      // Reliable: a dropped chat line is far more confusing than a late one.
      await room.localParticipant.publishData(sealed, { reliable: true });

      counterRef.current += 1;
      setMessages((previous) =>
        [
          ...previous,
          { id: `m${counterRef.current}`, senderName: 'You', isLocal: true, at, text: trimmed },
        ].slice(-MAX_MESSAGES),
      );
    },
    [room],
  );

  const markRead = useCallback(() => setUnread(0), []);

  return { messages, unread, sendChat, markRead };
}
