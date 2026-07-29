/**
 * Encrypted data-channel messages.
 *
 * LiveKit's E2EE covers *media frames only*. Data-channel payloads travel over
 * DTLS/SCTP, which is encrypted hop-by-hop — meaning the SFU can read them.
 * Sending chat as plain JSON would therefore hand the server every message in
 * an app whose entire premise is that it cannot read the conversation.
 *
 * So messages carry their own AES-GCM envelope, keyed from the same room secret
 * that lives in the URL fragment. The server relays ciphertext it has no key
 * for, exactly as it does for audio and video.
 */
import { decodeRoomKey } from './e2ee';

export type ChatMessage = {
  type: 'chat';
  /** Millisecond timestamp from the sender's clock; display only. */
  at: number;
  text: string;
};

/**
 * A request that someone mute themselves.
 *
 * Deliberately a *request*, honoured by the recipient's own client, not an
 * enforced server-side mute. Enforcing it would require handing a participant
 * administrative rights over the room, which is a much larger change to the
 * trust model than the problem justifies — the problem being an accidental hot
 * mic, where the person is not adversarial, just unaware.
 */
export type MuteRequest = {
  type: 'mute-request';
  at: number;
};

/**
 * A transient reaction. Deliberately not persisted anywhere — it exists for the
 * few seconds it is on screen and then it is gone, like a nod in a room.
 */
export type Reaction = {
  type: 'reaction';
  at: number;
  emoji: string;
};

/** Raised-hand state. Sent on change, and re-sent when someone new joins. */
export type HandState = {
  type: 'hand';
  at: number;
  up: boolean;
};

/** Shared countdown, so the clock belongs to the meeting rather than one person. */
export type Timebox = {
  type: 'timebox';
  at: number;
  /** Epoch ms when the meeting should end, or null to clear. */
  endsAt: number | null;
};

/** A quick vote. Choices are fixed so no peer-supplied option list is rendered. */
export type Poll = {
  type: 'poll';
  at: number;
  id: string;
  question: string;
};

export type Vote = {
  type: 'vote';
  at: number;
  pollId: string;
  choice: PollChoice;
};

export const POLL_CHOICES = ['yes', 'no', 'abstain'] as const;
export type PollChoice = (typeof POLL_CHOICES)[number];
export const POLL_QUESTION_MAX = 140;

export type RoomMessage =
  | ChatMessage
  | MuteRequest
  | Reaction
  | HandState
  | Timebox
  | Poll
  | Vote;

/**
 * Allow-list of reaction emoji.
 *
 * A peer shares the room key and can therefore produce any valid ciphertext, so
 * the emoji is attacker-controlled text rendered into everyone's UI. Restricting
 * it to a fixed set means no arbitrary string — however long, however
 * adversarially composed — ever reaches a tile.
 */
export const REACTIONS = ['👍', '👏', '🎉', '😂', '❤️', '🤔'] as const;
export type ReactionEmoji = (typeof REACTIONS)[number];

/** Separate info string so the chat key is not the media key. */
const HKDF_INFO = 'nme-chat-v1';
const IV_BYTES = 12;
/** Rejects anything implausible before it reaches the crypto layer. */
const MAX_PAYLOAD_BYTES = 16 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Derives a chat key from the room key via HKDF.
 *
 * Using the room key directly for two different purposes would mean the same
 * key encrypting both media frames and chat, so a weakness or nonce reuse in
 * one context could undermine the other. Domain separation is cheap.
 */
export async function deriveChatKey(roomKey: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    decodeRoomKey(roomKey),
    'HKDF',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: encoder.encode(HKDF_INFO),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypts a message into `[12-byte IV][ciphertext]`.
 *
 * Typed as ArrayBuffer-backed because LiveKit's `publishData` will not accept a
 * possibly-shared buffer.
 */
export async function sealMessage(
  key: CryptoKey,
  message: RoomMessage,
): Promise<Uint8Array<ArrayBuffer>> {
  // A fresh random IV per message: reusing one under AES-GCM is catastrophic,
  // leaking the authentication key rather than just a single plaintext.
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = encoder.encode(JSON.stringify(message));

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

  const envelope = new Uint8Array(new ArrayBuffer(IV_BYTES + ciphertext.byteLength));
  envelope.set(iv, 0);
  envelope.set(new Uint8Array(ciphertext), IV_BYTES);
  return envelope;
}

/**
 * Decrypts and validates an incoming envelope.
 *
 * Returns `null` for anything that fails to authenticate or does not match the
 * expected shape. A participant is not automatically trusted: they share the
 * room key, so they can produce valid ciphertext, but the decoded object is
 * still attacker-controlled and is checked before use.
 */
export async function openMessage(
  key: CryptoKey,
  envelope: Uint8Array,
): Promise<RoomMessage | null> {
  if (envelope.byteLength <= IV_BYTES || envelope.byteLength > MAX_PAYLOAD_BYTES) return null;

  try {
    // Copied rather than passed as subarray views: a view may be backed by a
    // SharedArrayBuffer, which WebCrypto refuses. Messages are capped at 16 KB,
    // so the copy is irrelevant.
    const iv = new Uint8Array(envelope.subarray(0, IV_BYTES));
    const ciphertext = new Uint8Array(envelope.subarray(IV_BYTES));
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);

    const parsed: unknown = JSON.parse(decoder.decode(plaintext));
    return validate(parsed);
  } catch {
    // Authentication failure, or a peer using a different key. Silently ignored
    // — a decrypt error is not actionable by the user.
    return null;
  }
}

function validate(value: unknown): RoomMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const at = typeof record.at === 'number' ? record.at : Date.now();

  if (record.type === 'chat') {
    if (typeof record.text !== 'string') return null;
    const text = record.text.slice(0, 2000).trim();
    return text ? { type: 'chat', at, text } : null;
  }

  if (record.type === 'mute-request') {
    return { type: 'mute-request', at };
  }

  if (record.type === 'reaction') {
    // Anything outside the allow-list is dropped rather than rendered.
    const emoji = REACTIONS.find((allowed) => allowed === record.emoji);
    return emoji ? { type: 'reaction', at, emoji } : null;
  }

  if (record.type === 'hand') {
    return typeof record.up === 'boolean' ? { type: 'hand', at, up: record.up } : null;
  }

  if (record.type === 'timebox') {
    const endsAt = record.endsAt;
    if (endsAt === null) return { type: 'timebox', at, endsAt: null };
    // Bounded: an absurd end time from a peer would render a nonsense
    // countdown, and this value drives a timer on every client.
    if (typeof endsAt !== 'number' || !Number.isFinite(endsAt)) return null;
    const maxEnd = Date.now() + 24 * 60 * 60 * 1000;
    return endsAt > 0 && endsAt < maxEnd ? { type: 'timebox', at, endsAt } : null;
  }

  if (record.type === 'poll') {
    if (typeof record.id !== 'string' || typeof record.question !== 'string') return null;
    const question = record.question.slice(0, POLL_QUESTION_MAX).trim();
    // The question is peer-supplied text rendered into every participant's UI.
    // React escapes it; the cap stops a wall of text from taking over the panel.
    return question && record.id.length <= 64
      ? { type: 'poll', at, id: record.id.slice(0, 64), question }
      : null;
  }

  if (record.type === 'vote') {
    const choice = POLL_CHOICES.find((allowed) => allowed === record.choice);
    return choice && typeof record.pollId === 'string'
      ? { type: 'vote', at, pollId: record.pollId.slice(0, 64), choice }
      : null;
  }

  return null;
}
