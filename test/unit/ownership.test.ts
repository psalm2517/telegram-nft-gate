import { describe, expect, it } from 'vitest';
import { OwnershipChecker } from '../../src/services/ownership.js';
import { TEST_COLLECTION } from '../helpers.js';

/** Build a checker whose transport is a canned response or thrown error. */
function checkerReturning(handler: (req: Request) => Promise<Response> | Response) {
  return new OwnershipChecker({
    apiKey: 'k',
    collectionId: TEST_COLLECTION,
    endpoint: 'https://das.test/',
    timeoutMs: 50,
    fetchImpl: (input, init) => Promise.resolve(handler(new Request(input as string, init))),
  });
}

const asset = (collection: string = TEST_COLLECTION) => ({
  id: 'mint-1',
  grouping: [{ group_key: 'collection', group_value: collection }],
});

const rpcOk = (items: unknown[]) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', result: { total: items.length, items } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('OwnershipChecker', () => {
  it('reports OWNED for a holder of one qualifying NFT', async () => {
    const res = await checkerReturning(() => rpcOk([asset()])).ownsAtLeastOne('wallet');
    expect(res.status).toBe('OWNED');
  });

  it('reports OWNED and a count for a holder of several', async () => {
    const res = await checkerReturning(() =>
      rpcOk([asset(), asset(), asset()]),
    ).countOwned('wallet');
    expect(res.status).toBe('OWNED');
    expect(res.count).toBe(3);
  });

  it('reports NOT_OWNED for an empty result', async () => {
    const res = await checkerReturning(() => rpcOk([])).ownsAtLeastOne('wallet');
    expect(res.status).toBe('NOT_OWNED');
    expect(res.count).toBe(0);
  });

  it('ignores assets from a different collection even if the API returns them', async () => {
    // Defence in depth: we never rely solely on the provider's grouping filter.
    const res = await checkerReturning(() =>
      rpcOk([asset('SomeOtherCollectionAddress1111111111111111')]),
    ).ownsAtLeastOne('wallet');
    expect(res.status).toBe('NOT_OWNED');
  });

  it('sends the configured collection id and a limit of 1 for the boolean gate', async () => {
    let body: { params: { grouping: string[]; limit: number; tokenType: string } } | null = null;
    const checker = new OwnershipChecker({
      apiKey: 'k',
      collectionId: TEST_COLLECTION,
      endpoint: 'https://das.test/',
      fetchImpl: async (_i, init) => {
        body = JSON.parse(init!.body as string);
        return rpcOk([asset()]);
      },
    });
    await checker.ownsAtLeastOne('wallet');
    expect(body!.params.grouping).toEqual(['collection', TEST_COLLECTION]);
    expect(body!.params.limit).toBe(1);
    expect(body!.params.tokenType).toBe('nonFungible');
  });

  // --- failures must never look like "sold their NFT" -----------------------

  it('treats a 500 as INDETERMINATE, not NOT_OWNED', async () => {
    const res = await checkerReturning(() => new Response('boom', { status: 500 }))
      .ownsAtLeastOne('wallet');
    expect(res.status).toBe('INDETERMINATE');
    expect(res.reason).toBe('http_500');
  });

  it('treats a 429 as INDETERMINATE (rate limited)', async () => {
    const res = await checkerReturning(() => new Response('', { status: 429 }))
      .ownsAtLeastOne('wallet');
    expect(res.status).toBe('INDETERMINATE');
    expect(res.reason).toBe('rate_limited');
  });

  it('treats a JSON-RPC rate-limit error as INDETERMINATE', async () => {
    const res = await checkerReturning(
      () =>
        new Response(JSON.stringify({ error: { code: -32000, message: 'Rate limit exceeded' } }), {
          status: 200,
        }),
    ).ownsAtLeastOne('wallet');
    expect(res.status).toBe('INDETERMINATE');
    expect(res.reason).toBe('rate_limited');
  });

  it('treats a generic JSON-RPC error as INDETERMINATE', async () => {
    const res = await checkerReturning(
      () => new Response(JSON.stringify({ error: { message: 'internal' } }), { status: 200 }),
    ).ownsAtLeastOne('wallet');
    expect(res.status).toBe('INDETERMINATE');
    expect(res.reason).toBe('rpc_error');
  });

  it('treats a malformed body as INDETERMINATE', async () => {
    const res = await checkerReturning(() => new Response('not json', { status: 200 }))
      .ownsAtLeastOne('wallet');
    expect(res.status).toBe('INDETERMINATE');
    expect(res.reason).toBe('malformed_response');
  });

  it('treats an unexpected response shape as INDETERMINATE', async () => {
    const res = await checkerReturning(
      () => new Response(JSON.stringify({ result: { unexpected: true } }), { status: 200 }),
    ).ownsAtLeastOne('wallet');
    expect(res.status).toBe('INDETERMINATE');
    expect(res.reason).toBe('malformed_response');
  });

  it('treats an empty body (observed in the wild) as INDETERMINATE', async () => {
    const res = await checkerReturning(() => new Response('', { status: 200 }))
      .ownsAtLeastOne('wallet');
    expect(res.status).toBe('INDETERMINATE');
  });

  it('treats a network error as INDETERMINATE', async () => {
    const checker = new OwnershipChecker({
      apiKey: 'k',
      collectionId: TEST_COLLECTION,
      endpoint: 'https://das.test/',
      fetchImpl: () => Promise.reject(new TypeError('network down')),
    });
    const res = await checker.ownsAtLeastOne('wallet');
    expect(res.status).toBe('INDETERMINATE');
    expect(res.reason).toBe('network_error');
  });

  it('treats a timeout as INDETERMINATE', async () => {
    const checker = new OwnershipChecker({
      apiKey: 'k',
      collectionId: TEST_COLLECTION,
      endpoint: 'https://das.test/',
      timeoutMs: 20,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    });
    const res = await checker.ownsAtLeastOne('wallet');
    expect(res.status).toBe('INDETERMINATE');
    expect(res.reason).toBe('timeout');
  });

  it('accepts the alternate { assets: {...} } envelope', async () => {
    const res = await checkerReturning(
      () =>
        new Response(
          JSON.stringify({ result: { assets: { total: 1, items: [asset()] } } }),
          { status: 200 },
        ),
    ).ownsAtLeastOne('wallet');
    expect(res.status).toBe('OWNED');
  });
});

describe('OwnershipChecker.validateCollection', () => {
  const collectionAsset = {
    id: TEST_COLLECTION,
    interface: 'MplCoreCollection',
    content: { metadata: { name: 'Solana Business Frogs' } },
    grouping: [],
  };

  const respondTo = (byId: Record<string, unknown>) =>
    new OwnershipChecker({
      apiKey: 'k',
      collectionId: TEST_COLLECTION,
      endpoint: 'https://das.test/',
      fetchImpl: async (_i, init) => {
        const parsed = JSON.parse(init!.body as string) as { params: { id: string } };
        const result = byId[parsed.params.id];
        if (!result) return new Response(JSON.stringify({ error: { message: 'not found' } }));
        return new Response(JSON.stringify({ result }));
      },
    });

  it('passes when the id is a collection and the samples group to it', async () => {
    const report = await respondTo({
      [TEST_COLLECTION]: collectionAsset,
      mintA: { id: 'mintA', interface: 'MplCoreAsset', grouping: [{ group_key: 'collection', group_value: TEST_COLLECTION }], content: { metadata: { name: 'Frog #1' } } },
    }).validateCollection(['mintA']);

    expect(report.ok).toBe(true);
    expect(report.collectionName).toBe('Solana Business Frogs');
    expect(report.samples[0]!.belongs).toBe(true);
  });

  it('fails when the configured id is an individual mint, not a collection', async () => {
    const report = await respondTo({
      [TEST_COLLECTION]: { id: TEST_COLLECTION, interface: 'MplCoreAsset', grouping: [] },
    }).validateCollection([]);
    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toMatch(/not a collection asset/);
  });

  it('fails, without substituting anything, when a sample groups elsewhere', async () => {
    const report = await respondTo({
      [TEST_COLLECTION]: collectionAsset,
      mintA: { id: 'mintA', interface: 'MplCoreAsset', grouping: [{ group_key: 'collection', group_value: 'DifferentCollection' }] },
    }).validateCollection(['mintA']);

    expect(report.ok).toBe(false);
    // The reported id must still be the configured one — never a discovered replacement.
    expect(report.collectionId).toBe(TEST_COLLECTION);
    expect(report.problems.join(' ')).toMatch(/does not group to/);
  });

  it('fails loudly when the collection id cannot be fetched at all', async () => {
    const report = await respondTo({}).validateCollection([]);
    expect(report.ok).toBe(false);
    expect(report.problems[0]).toMatch(/Could not fetch/);
  });
});

describe('OwnershipChecker.getCollectionName', () => {
  it('returns the collection asset\'s display name', async () => {
    const checker = new OwnershipChecker({
      apiKey: 'k',
      collectionId: TEST_COLLECTION,
      endpoint: 'https://das.test/',
      fetchImpl: async () =>
        new Response(JSON.stringify({
          result: { id: TEST_COLLECTION, interface: 'MplCoreCollection', content: { metadata: { name: 'Solana Business Frogs' } } },
        })),
    });
    expect(await checker.getCollectionName()).toBe('Solana Business Frogs');
  });

  it('returns null rather than throwing when the collection cannot be fetched', async () => {
    const checker = new OwnershipChecker({
      apiKey: 'k',
      collectionId: TEST_COLLECTION,
      endpoint: 'https://das.test/',
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'not found' } })),
    });
    expect(await checker.getCollectionName()).toBeNull();
  });

  it('returns null when the asset has no metadata name', async () => {
    const checker = new OwnershipChecker({
      apiKey: 'k',
      collectionId: TEST_COLLECTION,
      endpoint: 'https://das.test/',
      fetchImpl: async () =>
        new Response(JSON.stringify({ result: { id: TEST_COLLECTION, interface: 'MplCoreCollection' } })),
    });
    expect(await checker.getCollectionName()).toBeNull();
  });
});
