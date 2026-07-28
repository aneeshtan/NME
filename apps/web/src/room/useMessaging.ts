/**
 * Chat and in-room control messages over LiveKit's data channel.
 *
 * Everything here is encrypted with a key derived from the room secret, so the
 * SFU relays ciphertext — see lib/messaging.ts for why that is not automatic.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { RoomEvent, type Participant, type Room } from 'livekit-client';
import { deriveChatKey, openMessage, sealMessage } from '../lib/messaging';

export interface ChatEntry {
  id: string;
  senderName: string;
  senderIdentity: string;
  isLocal: boolean;
  text: string;
  at: number;
}

export interface Messaging {
  messages: ChatEntry[];
  /** Messages received while the chat panel was closed. */
  unread: number;
  markRead: () => void;
  sendChat: (text: string) => Promise<void>;
  askToMute: (identity: string) => Promise<void>;
  /** Set when someone asked us to mute; cleared by the consumer. */
  muteRequestFrom: string | null;
  clearMuteRequest: () => void;
}

/** Keeps memory bounded on a long call; chat is transient by design. */
const MAX_MESSAGES = 200;

export function useMessaging(
  room: Room | null,
  roomKey: string | null,
  chatOpen: boolean,
  onMuteRequested: () => void,
): Messaging {
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [unread, setUnread] = useState(0);
  const [muteRequestFrom, setMuteRequestFrom] = useState<string | null>(null);
  const keyRef = useRef<CryptoKey | null>(null);
  // Read inside the event handler so the listener does not need re-binding
  // every time the panel opens or closes.
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;

  const muteHandlerRef = useRef(onMuteRequested);
  muteHandlerRef.current = onMuteRequested;

  useEffect(() => {
    if (!roomKey) return;
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
      if (!key || !participant) return;

      void openMessage(key, payload).then((message) => {
        if (!message) return;

        if (message.type === 'chat') {
          setMessages((current) => {
            const next = [
              ...current,
              {
                id: `${participant.identity}-${message.at}-${current.length}`,
                senderName: participant.name || 'Guest',
                senderIdentity: participant.identity,
                isLocal: false,
                text: message.text,
                at: message.at,
              },
            ];
            return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next;
          });

          if (!chatOpenRef.current) setUnread((count) => count + 1);
          return;
        }

        if (message.type === 'mute-request') {
          setMuteRequestFrom(participant.name || 'Someone');
          muteHandlerRef.current();
        }
      });
    };

    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room]);

  useEffect(() => {
    if (chatOpen) setUnread(0);
  }, [chatOpen, messages.length]);

  const sendChat = useCallback(
    async (text: string) => {
      const key = keyRef.current;
      const trimmed = text.trim();
      if (!room || !key || !trimmed) return;

      const message = { type: 'chat' as const, at: Date.now(), text: trimmed.slice(0, 2000) };
      const envelope = await sealMessage(key, message);
      // Reliable: a dropped chat message is far more confusing than a late one.
      await room.localParticipant.publishData(envelope, { reliable: true });

      // Echoed locally rather than round-tripped — the sender's own message
      // never comes back from the SFU.
      setMessages((current) => {
        const next = [
          ...current,
          {
            id: `local-${message.at}-${current.length}`,
            senderName: room.localParticipant.name || 'You',
            senderIdentity: room.localParticipant.identity,
            isLocal: true,
            text: message.text,
            at: message.at,
          },
        ];
        return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next;
      });
    },
    [room],
  );

  const askToMute = useCallback(
    async (identity: string) => {
      const key = keyRef.current;
      if (!room || !key) return;

      const envelope = await sealMessage(key, { type: 'mute-request', at: Date.now() });
      // Addressed to one participant so the request is not broadcast to the room.
      await room.localParticipant.publishData(envelope, {
        reliable: true,
        destinationIdentities: [identity],
      });
    },
    [room],
  );

  const markRead = useCallback(() => setUnread(0), []);
  const clearMuteRequest = useCallback(() => setMuteRequestFrom(null), []);

  return {
    messages,
    unread,
    markRead,
    sendChat,
    askToMute,
    muteRequestFrom,
    clearMuteRequest,
  };
}
