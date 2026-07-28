/**
 * Chat and in-room control messages over LiveKit's data channel.
 *
 * Everything here is encrypted with a key derived from the room secret, so the
 * SFU relays ciphertext — see lib/messaging.ts for why that is not automatic.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { RoomEvent, type Participant, type Room } from 'livekit-client';
import { deriveChatKey, openMessage, sealMessage, type ReactionEmoji } from '../lib/messaging';

export interface ChatEntry {
  id: string;
  senderName: string;
  senderIdentity: string;
  isLocal: boolean;
  text: string;
  at: number;
}

export interface ActiveReaction {
  identity: string;
  emoji: string;
  at: number;
}

export interface Messaging {
  /** Reactions currently on screen, keyed by sender. */
  reactions: ActiveReaction[];
  /** Identities with a raised hand. */
  raisedHands: Set<string>;
  handRaised: boolean;
  sendReaction: (emoji: ReactionEmoji) => Promise<void>;
  toggleHand: () => Promise<void>;
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
/** How long a reaction stays on screen. */
const REACTION_MS = 4000;

export function useMessaging(
  room: Room | null,
  roomKey: string | null,
  chatOpen: boolean,
  onMuteRequested: () => void,
): Messaging {
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [unread, setUnread] = useState(0);
  const [muteRequestFrom, setMuteRequestFrom] = useState<string | null>(null);
  const [reactions, setReactions] = useState<ActiveReaction[]>([]);
  const [raisedHands, setRaisedHands] = useState<Set<string>>(new Set());
  const [handRaised, setHandRaised] = useState(false);
  const handRaisedRef = useRef(false);
  handRaisedRef.current = handRaised;
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
          return;
        }

        if (message.type === 'reaction') {
          const entry = {
            identity: participant.identity,
            emoji: message.emoji,
            at: Date.now(),
          };
          // One reaction per person at a time: rapid taps replace rather than
          // stack, so nobody can paper the screen with emoji.
          setReactions((current) => [
            ...current.filter((r) => r.identity !== entry.identity),
            entry,
          ]);
          window.setTimeout(() => {
            setReactions((current) => current.filter((r) => r.at !== entry.at));
          }, REACTION_MS);
          return;
        }

        if (message.type === 'hand') {
          setRaisedHands((current) => {
            const next = new Set(current);
            if (message.up) next.add(participant.identity);
            else next.delete(participant.identity);
            return next;
          });
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

  const sendReaction = useCallback(
    async (emoji: ReactionEmoji) => {
      const key = keyRef.current;
      if (!room || !key) return;

      const envelope = await sealMessage(key, { type: 'reaction', at: Date.now(), emoji });
      // Lossy is right for a reaction: a dropped one is invisible, whereas
      // reliable delivery would queue it behind congestion and land it late.
      await room.localParticipant.publishData(envelope, { reliable: false });

      const entry = { identity: room.localParticipant.identity, emoji, at: Date.now() };
      setReactions((current) => [
        ...current.filter((r) => r.identity !== entry.identity),
        entry,
      ]);
      window.setTimeout(() => {
        setReactions((current) => current.filter((r) => r.at !== entry.at));
      }, REACTION_MS);
    },
    [room],
  );

  const broadcastHand = useCallback(
    async (up: boolean, to?: string[]) => {
      const key = keyRef.current;
      if (!room || !key) return;
      const envelope = await sealMessage(key, { type: 'hand', at: Date.now(), up });
      await room.localParticipant.publishData(envelope, {
        reliable: true,
        ...(to ? { destinationIdentities: to } : {}),
      });
    },
    [room],
  );

  const toggleHand = useCallback(async () => {
    const next = !handRaisedRef.current;
    setHandRaised(next);
    setRaisedHands((current) => {
      const updated = new Set(current);
      if (!room) return updated;
      if (next) updated.add(room.localParticipant.identity);
      else updated.delete(room.localParticipant.identity);
      return updated;
    });
    await broadcastHand(next);
  }, [room, broadcastHand]);

  /**
   * Hand state is edge-triggered, so someone joining after a hand went up would
   * never learn about it. Re-send ours privately to each new arrival.
   */
  useEffect(() => {
    if (!room) return;
    const onJoin = (participant: Participant) => {
      if (handRaisedRef.current) void broadcastHand(true, [participant.identity]);
    };
    room.on(RoomEvent.ParticipantConnected, onJoin);
    return () => {
      room.off(RoomEvent.ParticipantConnected, onJoin);
    };
  }, [room, broadcastHand]);

  /** A departing participant's raised hand must not linger in the list. */
  useEffect(() => {
    if (!room) return;
    const onLeave = (participant: Participant) => {
      setRaisedHands((current) => {
        if (!current.has(participant.identity)) return current;
        const next = new Set(current);
        next.delete(participant.identity);
        return next;
      });
    };
    room.on(RoomEvent.ParticipantDisconnected, onLeave);
    return () => {
      room.off(RoomEvent.ParticipantDisconnected, onLeave);
    };
  }, [room]);

  const markRead = useCallback(() => setUnread(0), []);
  const clearMuteRequest = useCallback(() => setMuteRequestFrom(null), []);

  return {
    reactions,
    raisedHands,
    handRaised,
    sendReaction,
    toggleHand,
    messages,
    unread,
    markRead,
    sendChat,
    askToMute,
    muteRequestFrom,
    clearMuteRequest,
  };
}
