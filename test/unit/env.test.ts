import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { ConfigError, loadConfig, type Env } from '../../src/env.js';

/** The full valid env from vitest.config.ts, minus whichever DAS fields a test wants to vary. */
function baseEnv(overrides: Partial<Env> = {}): Env {
  return { ...(env as unknown as Env), ...overrides };
}

describe('DAS endpoint resolution', () => {
  it('requires HELIUS_API_KEY when DAS_ENDPOINT is not set', () => {
    expect(() => loadConfig(baseEnv({ HELIUS_API_KEY: undefined, DAS_ENDPOINT: undefined }))).toThrow(
      ConfigError,
    );
  });

  it('also rejects an empty HELIUS_API_KEY, not just an absent one', () => {
    // The Cloudflare dashboard can leave a secret set to an empty string rather
    // than truly absent; both must be treated as "not configured".
    expect(() => loadConfig(baseEnv({ HELIUS_API_KEY: '', DAS_ENDPOINT: undefined }))).toThrow(
      ConfigError,
    );
  });

  it('builds the Helius endpoint from HELIUS_API_KEY when provided', () => {
    const config = loadConfig(baseEnv({ HELIUS_API_KEY: 'my-key', DAS_ENDPOINT: undefined }));
    expect(config.dasEndpoint).toBe('https://mainnet.helius-rpc.com/?api-key=my-key');
  });

  it('lets DAS_ENDPOINT override Helius entirely', () => {
    const config = loadConfig(
      baseEnv({ HELIUS_API_KEY: 'my-key', DAS_ENDPOINT: 'https://self-hosted.example/rpc' }),
    );
    expect(config.dasEndpoint).toBe('https://self-hosted.example/rpc');
  });

  it('accepts DAS_ENDPOINT alone, without any HELIUS_API_KEY', () => {
    const config = loadConfig(
      baseEnv({ HELIUS_API_KEY: undefined, DAS_ENDPOINT: 'https://self-hosted.example/rpc' }),
    );
    expect(config.dasEndpoint).toBe('https://self-hosted.example/rpc');
  });
});

describe('JOIN_VERIFICATION_HOURS default', () => {
  it('defaults to 1 hour when unset', () => {
    const config = loadConfig(baseEnv({ JOIN_VERIFICATION_HOURS: undefined }));
    expect(config.joinVerificationHours).toBe(1);
  });

  it('honours an explicit value', () => {
    const config = loadConfig(baseEnv({ JOIN_VERIFICATION_HOURS: '6' }));
    expect(config.joinVerificationHours).toBe(6);
  });
});

describe('MIGRATION_MODE default', () => {
  it('defaults to true (safe) when entirely unset', () => {
    const config = loadConfig(baseEnv({ MIGRATION_MODE: undefined }));
    expect(config.migrationMode).toBe(true);
  });

  it('still honours an explicit "false"', () => {
    const config = loadConfig(baseEnv({ MIGRATION_MODE: 'false' }));
    expect(config.migrationMode).toBe(false);
  });

  it('still honours an explicit "true"', () => {
    const config = loadConfig(baseEnv({ MIGRATION_MODE: 'true' }));
    expect(config.migrationMode).toBe(true);
  });
});

describe('TELEGRAM_GROUP_ID resolution', () => {
  it('resolves to an empty string when neither env nor KV has a group configured', () => {
    const config = loadConfig(baseEnv({ TELEGRAM_GROUP_ID: undefined }));
    expect(config.telegramGroupId).toBe('');
  });

  it('does not require TELEGRAM_GROUP_ID to pass config validation', () => {
    expect(() => loadConfig(baseEnv({ TELEGRAM_GROUP_ID: undefined }))).not.toThrow();
  });

  it('uses the env value when set', () => {
    const config = loadConfig(baseEnv({ TELEGRAM_GROUP_ID: '-1009999' }));
    expect(config.telegramGroupId).toBe('-1009999');
  });
});
