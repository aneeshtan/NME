/**
 * Everything the web client and the native clients must agree on.
 *
 * The rule for what belongs here: if two clients could implement it
 * differently and still both look correct, it belongs here. Key derivation,
 * the room-ID hash, the message envelope, and the wire shape of the control
 * plane are all in that category — a disagreement in any of them produces a
 * meeting where people can see each other and hear nothing, with no error
 * anywhere to explain why.
 *
 * Rendering is not in that category, and is deliberately absent.
 */
export {
  buildMeetingUrl,
  buildShortMeetingUrl,
  decodeRoomKey,
  deriveRoomId,
  generateRoomKey,
  mediaPassphrase,
  readRoomKeyFromAnyUrl,
  readRoomKeyFromUrl,
  safetyNumber,
} from './e2ee';

export {
  POLL_CHOICES,
  POLL_QUESTION_MAX,
  REACTIONS,
  deriveChatKey,
  openMessage,
  sealMessage,
} from './messaging';
export type {
  ChatMessage,
  HandState,
  MuteRequest,
  Poll,
  PollChoice,
  Reaction,
  ReactionEmoji,
  RoomMessage,
  Timebox,
  Vote,
} from './messaging';

export { isValidRoomId, parseMeetingInput } from './room';

export { readRoomKeyFromLink } from './deeplink';

export {
  ApiError,
  claimKnock,
  configureApi,
  createRoom,
  createRoomWithLobby,
  getConfig,
  joinRoom,
  listKnocks,
  RelayUnavailableError,
  resolveKnock,
} from './api';
export type {
  AdmitAuth,
  ClientConfig,
  IceServerConfig,
  JoinCredentials,
  JoinWaiting,
  PendingKnock,
} from './api';
