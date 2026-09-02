import { z } from 'zod';

/**
 * Ownership is deliberately TRI-state.
 *
 * A data-source fault (timeout, 5xx, rate limit, malformed body) must never be
 * collapsed into `NOT_OWNED`, because downstream that would look identical to
 * "the user sold their NFT" and would revoke an innocent member.
 */
export type OwnershipStatus = 'OWNED' | 'NOT_OWNED' | 'INDETERMINATE';

export interface OwnershipResult {
  status: OwnershipStatus;
  /**
   * Number of qualifying assets found, when known. Only populated for calls that
   * actually enumerate; the fast gate uses limit=1 and leaves this undefined
   * because DAS `total` reflects the returned page, not the wallet's inventory.
   */
  count?: number;
  /** Machine-readable cause when status is INDETERMINATE. */
  reason?: string;
}

/** Minimal shape we depend on. Extra fields from DAS are ignored. */
const assetSchema = z.object({
  id: z.string(),
  grouping: z
    .array(z.object({ group_key: z.string(), group_value: z.string().nullable().optional() }))
    .optional(),
});

const pageSchema = z.object({
  total: z.number().optional(),
  limit: z.number().optional(),
  page: z.number().optional(),
  items: z.array(assetSchema),
});

/**
 * DAS returns `{ result: {...page} }` normally, but wraps it as
 * `{ result: { assets: {...page} } }` when native-balance display options are on.
 * Accept both rather than trusting one provider's default.
 */
const rpcResponseSchema = z.object({
  error: z.object({ code: z.number().optional(), message: z.string().optional() }).optional(),
  result: z.union([pageSchema, z.object({ assets: pageSchema })]).optional(),
});

export interface OwnershipCheckerOptions {
  apiKey: string;
  collectionId: string;
  /** Overridable for tests and for self-hosted DAS endpoints. */
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class OwnershipChecker {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OwnershipCheckerOptions) {
    this.endpoint =
      options.endpoint ?? `https://mainnet.helius-rpc.com/?api-key=${options.apiKey}`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Does this wallet currently hold at least one asset from the configured
   * collection? `limit: 1` keeps this O(1) instead of pulling the wallet's
   * whole inventory.
   */
  async ownsAtLeastOne(walletAddress: string): Promise<OwnershipResult> {
    return this.search(walletAddress, 1, false);
  }

  /** Same question, but also reports how many qualifying assets were found. */
  async countOwned(walletAddress: string, limit = 1000): Promise<OwnershipResult> {
    return this.search(walletAddress, limit, true);
  }

  private async search(
    walletAddress: string,
    limit: number,
    wantCount: boolean,
  ): Promise<OwnershipResult> {
    const body = {
      jsonrpc: '2.0',
      id: 'ownership-check',
      method: 'searchAssets',
      params: {
        ownerAddress: walletAddress,
        tokenType: 'nonFungible',
        grouping: ['collection', this.options.collectionId],
        page: 1,
        limit,
      },
    };

    let response: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      return { status: 'INDETERMINATE', reason: aborted ? 'timeout' : 'network_error' };
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) return { status: 'INDETERMINATE', reason: 'rate_limited' };
    if (!response.ok) {
      return { status: 'INDETERMINATE', reason: `http_${response.status}` };
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { status: 'INDETERMINATE', reason: 'malformed_response' };
    }

    const parsed = rpcResponseSchema.safeParse(json);
    if (!parsed.success) return { status: 'INDETERMINATE', reason: 'malformed_response' };
    if (parsed.data.error) {
      const msg = parsed.data.error.message ?? '';
      const rateLimited = /rate.?limit|too many requests/i.test(msg);
      return { status: 'INDETERMINATE', reason: rateLimited ? 'rate_limited' : 'rpc_error' };
    }
    if (!parsed.data.result) return { status: 'INDETERMINATE', reason: 'malformed_response' };

    const page = 'assets' in parsed.data.result ? parsed.data.result.assets : parsed.data.result;

    // Defence in depth: the provider already filtered by grouping, but we never
    // rely on a remote filter alone to decide who gets in.
    const qualifying = page.items.filter((item) =>
      (item.grouping ?? []).some(
        (g) => g.group_key === 'collection' && g.group_value === this.options.collectionId,
      ),
    );

    if (qualifying.length === 0) return { status: 'NOT_OWNED', count: 0 };
    return wantCount
      ? { status: 'OWNED', count: qualifying.length }
      : { status: 'OWNED' };
  }

  /**
   * Setup-time validation (CLAUDE.md §5): confirm the configured collection id is
   * a real, certified on-chain collection, and that sample mints really belong to it.
   *
   * This never substitutes or discovers a different id — it only reports agreement
   * or disagreement, so a misconfiguration fails loudly instead of silently gating
   * on the wrong collection.
   */
  async validateCollection(sampleMints: string[] = []): Promise<{
    ok: boolean;
    collectionId: string;
    collectionName?: string;
    interface?: string;
    problems: string[];
    samples: { mint: string; belongs: boolean; name?: string; reason?: string }[];
  }> {
    const problems: string[] = [];
    const samples: { mint: string; belongs: boolean; name?: string; reason?: string }[] = [];

    const collection = await this.getAsset(this.options.collectionId);
    if (collection.status !== 'ok') {
      problems.push(
        `Could not fetch NFT_COLLECTION_ID ${this.options.collectionId} from DAS (${collection.reason}).`,
      );
      return { ok: false, collectionId: this.options.collectionId, problems, samples };
    }

    const iface = collection.asset.interface;
    const name = collection.asset.content?.metadata?.name;
    // Certified collection assets present as a collection interface, not as a member NFT.
    if (!/collection/i.test(iface ?? '')) {
      problems.push(
        `NFT_COLLECTION_ID resolves to interface "${iface}", which is not a collection asset. ` +
          `It may be an individual mint, a candy machine, or a creator address.`,
      );
    }

    for (const mint of sampleMints) {
      const res = await this.getAsset(mint);
      if (res.status !== 'ok') {
        samples.push({ mint, belongs: false, reason: res.reason });
        problems.push(`Sample mint ${mint} could not be fetched (${res.reason}).`);
        continue;
      }
      const belongs = (res.asset.grouping ?? []).some(
        (g) => g.group_key === 'collection' && g.group_value === this.options.collectionId,
      );
      samples.push({
        mint,
        belongs,
        name: res.asset.content?.metadata?.name,
      });
      if (!belongs) {
        problems.push(
          `Sample mint ${mint} does not group to ${this.options.collectionId}. ` +
            `Its grouping is ${JSON.stringify(res.asset.grouping ?? [])}.`,
        );
      }
    }

    return {
      ok: problems.length === 0,
      collectionId: this.options.collectionId,
      collectionName: name,
      interface: iface,
      problems,
      samples,
    };
  }

  /**
   * The collection's own display name (e.g. "Solana Business Frogs"), for
   * de-genericizing user-facing text — "hold an NFT from {name}" instead of
   * "hold a qualifying NFT". Derived from the chain, not operator config, so
   * it needs nothing beyond NFT_COLLECTION_ID to work. Returns null on any
   * failure; callers should fall back to generic phrasing, never block on it.
   */
  async getCollectionName(): Promise<string | null> {
    const res = await this.getAsset(this.options.collectionId);
    if (res.status !== 'ok') return null;
    return res.asset.content?.metadata?.name ?? null;
  }

  private async getAsset(
    id: string,
  ): Promise<
    | { status: 'ok'; asset: z.infer<typeof singleAssetSchema> }
    | { status: 'error'; reason: string }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'get-asset', method: 'getAsset', params: { id } }),
        signal: controller.signal,
      });
      if (!res.ok) return { status: 'error', reason: `http_${res.status}` };
      const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (json.error) return { status: 'error', reason: json.error.message ?? 'rpc_error' };
      const parsed = singleAssetSchema.safeParse(json.result);
      if (!parsed.success) return { status: 'error', reason: 'malformed_response' };
      return { status: 'ok', asset: parsed.data };
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      return { status: 'error', reason: aborted ? 'timeout' : 'network_error' };
    } finally {
      clearTimeout(timer);
    }
  }
}

const singleAssetSchema = z.object({
  id: z.string(),
  interface: z.string().optional(),
  content: z
    .object({ metadata: z.object({ name: z.string().optional() }).optional() })
    .optional(),
  grouping: z
    .array(z.object({ group_key: z.string(), group_value: z.string().nullable().optional() }))
    .optional(),
});
