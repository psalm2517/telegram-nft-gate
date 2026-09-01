import type { Env } from '../src/env.js';

/**
 * `cloudflare:test` types its `env` as the global `Cloudflare.Env`, which is
 * normally produced by `wrangler types`. This project keeps `src/env.ts` as the
 * single hand-written source of truth for bindings, so point the global at it
 * rather than committing a generated file.
 */
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {}
  }
}

type AppEnv = Env;

export {};
