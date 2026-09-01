export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string = 'error',
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (m: string, code = 'bad_request') => new HttpError(400, m, code);
export const unauthorized = (m = 'Unauthorized', code = 'unauthorized') => new HttpError(401, m, code);
export const forbidden = (m = 'Forbidden', code = 'forbidden') => new HttpError(403, m, code);
export const notFound = (m = 'Not found', code = 'not_found') => new HttpError(404, m, code);
export const tooManyRequests = (m = 'Too many requests', code = 'rate_limited') =>
  new HttpError(429, m, code);
