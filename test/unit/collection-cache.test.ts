import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { getCachedCollectionName } from '../../src/collection-cache.js';
import type { OwnershipChecker } from '../../src/services/ownership.js';

const COLLECTION_ID = 'J7rxtKmEpNJEtrfkagiTF1gsmLyVus6BQZFY4ouBkeMG';
const CACHE_KEY = `cache:collection_name:${COLLECTION_ID}`;

/** Counts calls so tests can assert the DAS lookup only happens on a cache miss. */
function fakeOwnership(name: string | null): { checker: OwnershipChecker; calls: number[] } {
  const calls: number[] = [];
  const checker = {
    getCollectionName: async () => {
      calls.push(1);
      return name;
    },
  } as unknown as OwnershipChecker;
  return { checker, calls };
}

describe('getCachedCollectionName', () => {
  beforeEach(async () => {
    await env.KV.delete(CACHE_KEY);
  });

  it('fetches and caches the name on a cache miss', async () => {
    const { checker, calls } = fakeOwnership('Solana Business Frogs');
    const name = await getCachedCollectionName(env.KV, checker, COLLECTION_ID);
    expect(name).toBe('Solana Business Frogs');
    expect(calls).toHaveLength(1);
    expect(await env.KV.get(CACHE_KEY)).toBe('Solana Business Frogs');
  });

  it('serves subsequent calls from KV without hitting DAS again', async () => {
    const { checker, calls } = fakeOwnership('Solana Business Frogs');
    await getCachedCollectionName(env.KV, checker, COLLECTION_ID);
    await getCachedCollectionName(env.KV, checker, COLLECTION_ID);
    await getCachedCollectionName(env.KV, checker, COLLECTION_ID);
    expect(calls).toHaveLength(1);
  });

  it('caches a null result too, so a persistent failure does not retry every call', async () => {
    const { checker, calls } = fakeOwnership(null);
    const first = await getCachedCollectionName(env.KV, checker, COLLECTION_ID);
    const second = await getCachedCollectionName(env.KV, checker, COLLECTION_ID);
    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
