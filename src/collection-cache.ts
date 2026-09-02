import type { OwnershipChecker } from './services/ownership.js';

/**
 * KV-cached lookup of the collection's on-chain display name.
 *
 * Every /start, /verify and page load would otherwise cost a DAS round-trip
 * just to render text — this makes that a cache hit after the first request.
 * Successes cache for a week (collection names essentially never change);
 * failures cache briefly, so a transient DAS outage doesn't permanently
 * disable the friendly name for an hour of retries.
 */
const CACHE_KEY_PREFIX = 'cache:collection_name:';
const SUCCESS_TTL_SECONDS = 7 * 24 * 60 * 60;
const FAILURE_TTL_SECONDS = 10 * 60;

export async function getCachedCollectionName(
  kv: KVNamespace,
  ownership: OwnershipChecker,
  collectionId: string,
): Promise<string | null> {
  const key = `${CACHE_KEY_PREFIX}${collectionId}`;
  const cached = await kv.get(key);
  if (cached !== null) return cached === '' ? null : cached;

  const name = await ownership.getCollectionName();
  await kv.put(key, name ?? '', {
    expirationTtl: name ? SUCCESS_TTL_SECONDS : FAILURE_TTL_SECONDS,
  });
  return name;
}
