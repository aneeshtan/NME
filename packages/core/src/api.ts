/**
 * Typed client for the control-plane API.
 *
 * On the web every request is same-origin (Caddy proxies `/api` alongside the
 * SPA), which keeps the CSP `connect-src` tight and sidesteps CORS preflights
 * on the join critical path.
 *
 * The mobile clients have no origin to be "same" as, so they set an absolute
 * base once at startup. That base is compiled into the app rather than read
 * from a link: a meeting URL is attacker-supplied, and letting one choose the
 * control plane would let a forged invitation point the app at a server that
 * hands back its own join token. The key would still be unreadable to that
 * server — but the participant would be in the attacker's room, talking to
 * whoever else the attacker admitted, which is the whole game.
 */

export interface ClientConfig {
  livekitUrl: string;
  maxParticipants: number;
  videoCodec: 'vp8' | 'vp9';
}

export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

/** A lobby room withholds the token until someone inside admits the joiner. */
export interface JoinWaiting {
  status: 'waiting';
  knockId: string;
}

export interface PendingKnock {
  id: string;
  displayName: string;
  createdAt: number;
}

export interface JoinCredentials {
  token: string;
  url: string;
  identity: string;
  displayName: string;
  /** Present only when relay credentials were requested and are configured. */
  iceServers?: IceServerConfig[];
}

/** Error carrying the server's machine-readable code so the UI can branch on it. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const TIMEOUT_MS = 10_000;

/** Empty means same-origin, which is what the browser build wants. */
let baseUrl = '';

/**
 * Points the client at an absolute control plane. Call once, before any
 * request; only the native clients need it.
 */
export function configureApi(options: { baseUrl: string }): void {
  const trimmed = options.baseUrl.replace(/\/+$/, '');
  if (trimmed && !trimmed.startsWith('https://')) {
    // Plain HTTP would expose the join token, and the room ID, to the network.
    throw new Error('API base URL must be https');
  }
  baseUrl = trimmed;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Abort rather than leaving the user staring at a spinner on a dead network.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // Only claim a JSON content type when a body is actually present. Fastify
  // parses the body against the declared Content-Type, so a bodyless POST
  // (e.g. create-room) that still sends `Content-Type: application/json` hits
  // an empty string as JSON input and is rejected with
  // FST_ERR_CTP_EMPTY_JSON_BODY before the route handler ever runs.
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api${path}`, {
      ...init,
      signal: controller.signal,
      // No cookies exist, and omitting them keeps the request simple (no preflight).
      credentials: 'omit',
      headers,
    });
  } catch (error) {
    // Matched by name rather than by `instanceof DOMException`: React Native
    // has no DOMException, so an instance check would misreport every timeout
    // on mobile as an unreachable server and send the user to look at their
    // Wi-Fi instead of waiting.
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ApiError('TIMEOUT', 'The server took too long to respond.', 0);
    }
    throw new ApiError('NETWORK', 'Could not reach the server.', 0);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new ApiError(
      body?.error ?? 'UNKNOWN',
      body?.message ?? 'Something went wrong.',
      response.status,
    );
  }

  return (await response.json()) as T;
}

let configPromise: Promise<ClientConfig> | null = null;

/** Runtime config, fetched once per page load and shared by all callers. */
export function getConfig(): Promise<ClientConfig> {
  configPromise ??= request<ClientConfig>('/config');
  return configPromise;
}

export function createRoom(): Promise<{ roomId: string }> {
  return request<{ roomId: string }>('/rooms', { method: 'POST' });
}

/**
 * Requests a join token.
 *
 * `relay` is set only on a retry, after a direct connection has already failed.
 * Asking for relay credentials up front would hand them to every participant —
 * and expose every participant to the relay — to solve a problem almost none of
 * them have.
 */
export function joinRoom(
  roomId: string,
  displayName: string,
  options: { relay?: boolean; hostKey?: string } = {},
): Promise<JoinCredentials | JoinWaiting> {
  return request<JoinCredentials | JoinWaiting>(
    `/rooms/${encodeURIComponent(roomId)}/join`,
    {
      method: 'POST',
      body: JSON.stringify(options.relay ? { displayName, relay: true } : { displayName }),
      // Sent as a header so the host secret never lands in a URL, a log line,
      // or a Referer.
      ...(options.hostKey ? { headers: { 'X-Host-Key': options.hostKey } } : {}),
    },
  );
}

export function createRoomWithLobby(
  lobby: boolean,
  roomId?: string,
): Promise<{ roomId: string; hostKey?: string }> {
  return request<{ roomId: string; hostKey?: string }>('/rooms', {
    method: 'POST',
    body: JSON.stringify(roomId ? { lobby, roomId } : { lobby }),
  });
}

/** Joiner: poll for the host's verdict. */
export function claimKnock(
  roomId: string,
  knockId: string,
  options: { relay?: boolean } = {},
): Promise<
  | ({ status: 'admitted' } & JoinCredentials)
  | { status: 'waiting' }
  | { status: 'denied' }
> {
  return request(`/rooms/${encodeURIComponent(roomId)}/knocks/${encodeURIComponent(knockId)}/claim`, {
    method: 'POST',
    body: JSON.stringify(options.relay ? { relay: true } : {}),
  });
}

/**
 * Proof that the caller may admit people: either the creator's host secret, or
 * an identity the SFU currently reports as connected.
 */
export interface AdmitAuth {
  hostKey?: string | null | undefined;
  identity?: string | null | undefined;
}

function admitHeaders(auth: AdmitAuth): Record<string, string> {
  const headers: Record<string, string> = {};
  if (auth.hostKey) headers['X-Host-Key'] = auth.hostKey;
  if (auth.identity) headers['X-Participant-Identity'] = auth.identity;
  return headers;
}

/** Who is waiting. Anyone in the meeting may ask. */
export function listKnocks(roomId: string, auth: AdmitAuth): Promise<{ knocks: PendingKnock[] }> {
  return request<{ knocks: PendingKnock[] }>(`/rooms/${encodeURIComponent(roomId)}/knocks`, {
    headers: admitHeaders(auth),
  });
}

/** Admit or deny a waiting joiner. Anyone in the meeting may decide. */
export function resolveKnock(
  roomId: string,
  knockId: string,
  auth: AdmitAuth,
  admit: boolean,
): Promise<{ status: string }> {
  return request<{ status: string }>(
    `/rooms/${encodeURIComponent(roomId)}/knocks/${encodeURIComponent(knockId)}`,
    {
      method: 'POST',
      body: JSON.stringify({ admit }),
      headers: admitHeaders(auth),
    },
  );
}
