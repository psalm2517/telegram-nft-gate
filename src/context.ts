import { getConfiguredGroupId } from './config-store.js';
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
 * this is constructed per invocation. The only I/O here is the KV read below.
 */
export async function createContext(env: Env, requestUrl?: string): Promise<AppContext> {
  const config = loadConfig(env);

  // A group confirmed at runtime via /setup always wins over a deploy-time
  // TELEGRAM_GROUP_ID, so /setup can (re)point the gate even for a deployment
  // that originally pinned a group through the env var.
  const confirmedGroupId = await getConfiguredGroupId(env.KV);
  if (confirmedGroupId) config.telegramGroupId = confirmedGroupId;

  const db = new Database(env.DB);
  const telegram = new TelegramClient({
    botToken: config.telegramBotToken,
    groupId: config.telegramGroupId,
  });
  // config.dasEndpoint is always resolved by loadConfig (Helius if a key was
  // given, otherwise the public Solana RPC), so it is passed explicitly here
  // rather than relying on OwnershipChecker's own Helius-shaped default.
  const ownership = new OwnershipChecker({
    apiKey: config.heliusApiKey ?? '',
    collectionId: config.nftCollectionId,
    endpoint: config.dasEndpoint,
  });
  const access = new AccessService(db, telegram, ownership, config);
  const verification = new VerificationService(db, ownership, access, config);
  const rateLimiter = new RateLimiter(env.KV);

  const baseUrl =
    config.publicBaseUrl?.replace(/\/+$/, '') ??
    (requestUrl ? new URL(requestUrl).origin : 'http://localhost:8787');

  return { env, config, db, telegram, ownership, access, verification, rateLimiter, baseUrl };
}
