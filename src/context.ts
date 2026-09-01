import { loadConfig, type Config, type Env } from './env.js';
import { AccessService } from './services/access.js';
import { Database } from './services/db.js';
import { OwnershipChecker } from './services/ownership.js';
import { RateLimiter } from './services/ratelimit.js';
import { TelegramClient } from './services/telegram.js';
import { VerificationService } from './services/verification.js';

export interface AppContext {
  env: Env;
  config: Config;
  db: Database;
  telegram: TelegramClient;
  ownership: OwnershipChecker;
  access: AccessService;
  verification: VerificationService;
  rateLimiter: RateLimiter;
  baseUrl: string;
}

/**
 * Build the service graph for one request/invocation.
 *
 * Workers give no safe place for cross-request singletons that hold config, so
 * this is constructed per invocation. It is cheap: no I/O happens here.
 */
export function createContext(env: Env, requestUrl?: string): AppContext {
  const config = loadConfig(env);
  const db = new Database(env.DB);
  const telegram = new TelegramClient({
    botToken: config.telegramBotToken,
    groupId: config.telegramGroupId,
  });
  const ownership = new OwnershipChecker({
    apiKey: config.heliusApiKey,
    collectionId: config.nftCollectionId,
  });
  const access = new AccessService(db, telegram, ownership, config);
  const verification = new VerificationService(db, ownership, access, config);
  const rateLimiter = new RateLimiter(env.KV);

  const baseUrl =
    config.publicBaseUrl?.replace(/\/+$/, '') ??
    (requestUrl ? new URL(requestUrl).origin : 'http://localhost:8787');

  return { env, config, db, telegram, ownership, access, verification, rateLimiter, baseUrl };
}
