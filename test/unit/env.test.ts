import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { loadConfig, PUBLIC_SOLANA_RPC, type Env } from '../../src/env.js';

/** The full valid env from vitest.config.ts, minus whichever DAS fields a test wants to vary. */
function baseEnv(overrides: Partial<Env> = {}): Env {
  return { ...(env as unknown as Env), ...overrides };
}

describe('DAS endpoint resolution', () => {
  it('falls back to the public Solana RPC when no Helius key or endpoint is set', () => {
    const config = loadConfig(baseEnv({ HELIUS_API_KEY: undefined, DAS_ENDPOINT: undefined }));
    expect(config.dasEndpoint).toBe(PUBLIC_SOLANA_RPC);
  });

  it('also falls back when HELIUS_API_KEY is present but empty', () => {
    // The Cloudflare dashboard can leave a secret set to an empty string rather
    // than truly absent; both must resolve the same way.
    const config = loadConfig(baseEnv({ HELIUS_API_KEY: '', DAS_ENDPOINT: undefined }));
    expect(config.dasEndpoint).toBe(PUBLIC_SOLANA_RPC);
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

  it('does not require HELIUS_API_KEY to pass config validation at all', () => {
    expect(() => loadConfig(baseEnv({ HELIUS_API_KEY: undefined }))).not.toThrow();
  });
});
