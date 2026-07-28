/**
 * Typed client for the control-plane API.
 *
 * Every request is same-origin (Caddy proxies `/api` alongside the SPA), which
 * keeps the CSP `connect-src` tight and sidesteps CORS preflights on the join
 * critical path.
 */

export interface ClientConfig {
  livekitUrl: string;
  maxParticipants: number;
  videoCodec: 'vp8' | 'vp9';
}

export interface JoinCredentials {
  token: string;
  url: string;
  identity: string;
  displayName: string;
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
    response = await fetch(`/api${path}`, {
      ...init,
      signal: controller.signal,
      // No cookies exist, and omitting them keeps the request simple (no preflight).
      credentials: 'omit',
      headers,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
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

export function joinRoom(roomId: string, displayName: string): Promise<JoinCredentials> {
  return request<JoinCredentials>(`/rooms/${encodeURIComponent(roomId)}/join`, {
    method: 'POST',
    body: JSON.stringify({ displayName }),
  });
}
