import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Migrations are read on the host and replayed inside the Worker runtime, so the
// tests exercise the exact SQL that ships.
const migrations = await readD1Migrations('./migrations');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        compatibilityDate: '2025-08-01',
        compatibilityFlags: ['nodejs_compat'],
        bindings: {
          APP_NAME: 'test-gate',
          ACCESS_GRACE_PERIOD_HOURS: '24',
          MIGRATION_MODE: 'false',
          CHALLENGE_TTL_SECONDS: '300',
          RECHECK_BATCH_SIZE: '100',
          RECHECK_INTERVAL_HOURS: '12',
          TELEGRAM_BOT_TOKEN: '123456789:TEST-TOKEN-FOR-UNIT-TESTS-ONLY',
          TELEGRAM_GROUP_ID: '-1001234567890',
          TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
          NFT_COLLECTION_ID: 'J7rxtKmEpNJEtrfkagiTF1gsmLyVus6BQZFY4ouBkeMG',
          HELIUS_API_KEY: 'test-helius-key',
          ADMIN_TELEGRAM_IDS: '111111,222222',
          SESSION_SECRET: 'test-session-secret-at-least-16-chars',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    provide: { TEST_MIGRATIONS: migrations },
  },
});
