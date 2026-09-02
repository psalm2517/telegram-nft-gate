import { createContext, type AppContext } from './context.js';
import { ConfigError, type Env } from './env.js';
import { errorResponse, json } from './lib/http.js';
import { handleTelegramWebhook } from './routes/telegram.js';
import { handleChallenge, handlePublicConfig, handleSubmit } from './routes/verify.js';
import { runScheduledRecheck } from './scheduled.js';

function segments(pathname: string): string[] {
  return pathname.split('/').filter(Boolean);
}

/**
 * Returns a Response when this request belongs to the Worker's API surface, or
 * `null` when no route matched so the caller can fall through to static assets.
 *
 * "No route matched" is deliberately distinct from a handler throwing a 404
 * (e.g. "no such user"): the latter is a real API answer and must stay JSON,
 * not silently become the SPA's index.html with a 200.
 */
async function route(request: Request, ctx: AppContext): Promise<Response | null> {
  const url = new URL(request.url);
  const parts = segments(url.pathname);
  const method = request.method.toUpperCase();

  // --- Telegram webhook -----------------------------------------------------
  if (parts[0] === 'telegram' && parts[1] === 'webhook') {
    if (method !== 'POST') return null;
    return handleTelegramWebhook(request, ctx);
  }

  if (parts[0] !== 'api') return null;

  // --- health ---------------------------------------------------------------
  if (parts[1] === 'health' && method === 'GET') {
    return json({ ok: true, app: ctx.config.appName });
  }

  // --- verification -----------------------------------------------------------
  // Administration lives entirely in Telegram bot commands (see src/bot/bot.ts),
  // not in a separate web surface — there is no /api/admin/*.
  if (parts[1] === 'config' && method === 'GET') return await handlePublicConfig(ctx);
  if (parts[1] === 'verify' && parts[2] === 'challenge' && method === 'POST') {
    return handleChallenge(request, ctx);
  }
  if (parts[1] === 'verify' && parts[2] === 'submit' && method === 'POST') {
    return handleSubmit(request, ctx);
  }

  return null;
}

export default {
  async fetch(request: Request, env: Env, _executionCtx: ExecutionContext): Promise<Response> {
    let ctx: AppContext;
    try {
      ctx = await createContext(env, request.url);
    } catch (err) {
      if (err instanceof ConfigError) {
        // Misconfiguration is an operator problem; make it loud in logs but do not
        // echo which secrets are missing to the internet.
        console.error(err.message);
        return json(
          { error: 'misconfigured', message: 'The service is not configured correctly.' },
          { status: 500 },
        );
      }
      return errorResponse(err);
    }

    try {
      const response = await route(request, ctx);
      if (response) return response;
      // Nothing claimed this path, so it belongs to the React SPA served from
      // this same Worker via the ASSETS binding.
      return await env.ASSETS.fetch(request);
    } catch (err) {
      return errorResponse(err);
    }
  },

  async scheduled(_event: ScheduledController, env: Env, executionCtx: ExecutionContext): Promise<void> {
    const ctx = await createContext(env);
    executionCtx.waitUntil(
      runScheduledRecheck(ctx)
        .then((summary) => console.log('scheduled recheck complete', summary))
        .catch((err) => console.error('scheduled recheck failed', err)),
    );
  },
} satisfies ExportedHandler<Env>;
