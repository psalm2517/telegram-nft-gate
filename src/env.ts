import { z } from 'zod';

/** Bindings + vars declared in wrangler.jsonc, plus secrets set via `wrangler secret put`. */
export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS: Fetcher;

  // vars
  APP_NAME?: string;
  ACCESS_GRACE_PERIOD_HOURS?: string;
  MIGRATION_MODE?: string;
  CHALLENGE_TTL_SECONDS?: string;
  RECHECK_BATCH_SIZE?: string;
  RECHECK_INTERVAL_HOURS?: string;
  PUBLIC_BASE_URL?: string;

  // secrets
  TELEGRAM_BOT_TOKEN: string;
  /** Optional: omit to confirm the group conversationally instead (see /confirmgroup). */
  TELEGRAM_GROUP_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  NFT_COLLECTION_ID: string;
  /** Required unless DAS_ENDPOINT points at a different DAS-compatible provider. */
  HELIUS_API_KEY?: string;
  /** Optional: point ownership queries at any DAS-compatible RPC instead of Helius. */
  DAS_ENDPOINT?: string;
  ADMIN_TELEGRAM_IDS: string;
  SESSION_SECRET: string;
}

const base58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Truthy env string, with a default for when the var is absent entirely.
 * An explicit "true"/"false" (any case) always wins over the default.
 */
const boolish = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return defaultValue;
      return v.trim().toLowerCase() === 'true';
    });

const intFromString = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return fallback;
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    })
    .pipe(z.number().int().min(min).max(max));

/**
 * Telegram numeric ids are int64 and exceed Number.MAX_SAFE_INTEGER in theory,
 * so they are carried as strings everywhere in this codebase.
 */
const telegramId = z.string().regex(/^-?\d{1,20}$/, 'must be a numeric Telegram id');

export const configSchema = z.object({
  appName: z.string().min(1).default('telegram-nft-gate'),
  telegramBotToken: z.string().min(20, 'TELEGRAM_BOT_TOKEN is missing or malformed'),
  telegramGroupId: telegramId.optional(),
  telegramWebhookSecret: z.string().min(1).optional(),
  /**
   * The on-chain certified collection id. Operator-supplied and validated at setup;
   * never discovered or mutated at runtime. Deliberately NOT collection-specific in name.
   */
  nftCollectionId: z.string().regex(base58, 'NFT_COLLECTION_ID must be a base58 Solana address'),
  heliusApiKey: z.string().optional(),
  dasEndpoint: z.string().url().optional(),
  adminTelegramIds: z.array(telegramId).min(1, 'ADMIN_TELEGRAM_IDS must list at least one id'),
  sessionSecret: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),
  gracePeriodHours: z.number().int().min(0).max(24 * 365),
  migrationMode: z.boolean(),
  challengeTtlSeconds: z.number().int().min(30).max(3600),
  recheckBatchSize: z.number().int().min(1).max(1000),
  recheckIntervalHours: z.number().int().min(1).max(24 * 30),
  publicBaseUrl: z.string().url().optional(),
}).refine((c) => Boolean(c.heliusApiKey || c.dasEndpoint), {
  message: 'HELIUS_API_KEY is required unless DAS_ENDPOINT is set to a different DAS-compatible provider',
  path: ['heliusApiKey'],
});

export type Config = Omit<z.infer<typeof configSchema>, 'telegramGroupId'> & {
  dasEndpoint: string;
  /**
   * Always a string once loadConfig returns — '' when no group has been
   * configured or confirmed yet. context.ts may still overwrite this with a
   * value confirmed at runtime via KV; see createContext.
   */
  telegramGroupId: string;
};

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Env): Config {
  const parsed = configSchema.safeParse({
    appName: env.APP_NAME || 'telegram-nft-gate',
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramGroupId: env.TELEGRAM_GROUP_ID || undefined,
    telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET || undefined,
    nftCollectionId: env.NFT_COLLECTION_ID,
    heliusApiKey: env.HELIUS_API_KEY || undefined,
    dasEndpoint: env.DAS_ENDPOINT || undefined,
    adminTelegramIds: (env.ADMIN_TELEGRAM_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    sessionSecret: env.SESSION_SECRET,
    gracePeriodHours: intFromString(24, 0, 24 * 365).parse(env.ACCESS_GRACE_PERIOD_HOURS),
    // Defaults to true — an unconfigured deployment must not silently start
    // removing a community's existing members (CLAUDE.md §14).
    migrationMode: boolish(true).parse(env.MIGRATION_MODE),
    challengeTtlSeconds: intFromString(300, 30, 3600).parse(env.CHALLENGE_TTL_SECONDS),
    recheckBatchSize: intFromString(100, 1, 1000).parse(env.RECHECK_BATCH_SIZE),
    recheckIntervalHours: intFromString(12, 1, 24 * 30).parse(env.RECHECK_INTERVAL_HOURS),
    publicBaseUrl: env.PUBLIC_BASE_URL || undefined,
  });

  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }

  // The refine above guarantees at least one of these is set.
  const dasEndpoint =
    parsed.data.dasEndpoint ?? `https://mainnet.helius-rpc.com/?api-key=${parsed.data.heliusApiKey}`;

  return { ...parsed.data, dasEndpoint, telegramGroupId: parsed.data.telegramGroupId ?? '' };
}
