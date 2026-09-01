import { HttpError } from './errors.js';

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...SECURITY_HEADERS,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json({ error: err.code, message: err.message }, { status: err.status });
  }
  // Never leak internals to the client; the detail goes to the Worker log instead.
  console.error('unhandled error', err);
  return json({ error: 'internal_error', message: 'Something went wrong.' }, { status: 500 });
}

/** Parse and validate a JSON body, rejecting oversized or malformed input. */
export async function readJson(request: Request, maxBytes = 16 * 1024): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new HttpError(413, 'Request body too large', 'payload_too_large');
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new HttpError(413, 'Request body too large', 'payload_too_large');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'Body must be valid JSON', 'invalid_json');
  }
}

/** Best-effort client identity for rate limiting. */
export function clientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}
