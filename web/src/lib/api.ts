/**
 * Same-origin API client. There is no base URL and no CORS configuration because
 * the Worker serving this bundle also serves these routes.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    credentials: 'same-origin',
  });

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const err = body as { message?: string; error?: string } | null;
    throw new ApiError(
      err?.message ?? `Request failed (${res.status})`,
      err?.error ?? 'error',
      res.status,
    );
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
};

export interface PublicConfig {
  appName: string;
  collectionId: string;
  gracePeriodHours: number;
  migrationMode: boolean;
}

export interface ChallengeResponse {
  nonce: string;
  challenge: string;
  expiresAt: string;
}

/**
 * The bot delivers the session token in the URL fragment, which browsers never
 * put in the Referer header or send to the server in a request line.
 */
export function readTokenFromHash(): string | null {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;
  const token = new URLSearchParams(hash).get('token');
  return token && token.length > 0 ? token : null;
}

/** Remove the token from the address bar once it has been captured. */
export function clearHash(): void {
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

let captured = false;
let capturedToken: string | null = null;

/**
 * Read the token out of the URL fragment exactly once, then scrub the address bar.
 *
 * Idempotent, so it is safe as a `useState` lazy initializer even under
 * StrictMode's double-invoked render.
 */
export function consumeToken(): string | null {
  if (!captured) {
    capturedToken = readTokenFromHash();
    clearHash();
    captured = true;
  }
  return capturedToken;
}
