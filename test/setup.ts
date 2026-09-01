import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, inject } from 'vitest';

declare module 'vitest' {
  interface ProvidedContext {
    TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  }
}

// Isolated per-test storage means writes made here are visible to every test in
// the file, while each test still starts from this same clean baseline.
beforeAll(async () => {
  await applyD1Migrations(env.DB, inject('TEST_MIGRATIONS'));
});
