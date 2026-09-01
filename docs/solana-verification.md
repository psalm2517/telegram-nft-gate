# Solana verification

Two independent things must both hold before anyone is let in:

1. **Wallet control** — proven by an off-chain ed25519 signature.
2. **Ownership** — proven by a server-side DAS query.

Neither is taken on the frontend's word.

---

## Resolving a collection id

The `NFT_COLLECTION_ID` must be the **canonical on-chain certified collection
id**. These are *not* acceptable substitutes, and none of them will work:

- marketplace slugs (`solana_business_frogs`)
- collection names or symbols
- creator or update-authority addresses
- candy machine addresses
- an individual NFT's mint address

### The procedure

Take several known mints from the collection, ask DAS for each one, and read the
`grouping` array. Every member of a certified collection points at the same
collection address:

```bash
curl -s -X POST "https://mainnet.helius-rpc.com/?api-key=$HELIUS_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getAsset","params":{"id":"<MINT>"}}' \
  | jq '.result.grouping'
```

```json
[{ "group_key": "collection", "group_value": "J7rxtKmEpNJEtrfkagiTF1gsmLyVus6BQZFY4ouBkeMG" }]
```

Then confirm that address is itself a *collection* asset, not a member:

```bash
curl -s -X POST "https://mainnet.helius-rpc.com/?api-key=$HELIUS_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getAsset","params":{"id":"<COLLECTION>"}}' \
  | jq '{interface, name: .content.metadata.name}'
```

An `interface` containing `Collection` (`MplCoreCollection`, `V1_NFT` collection
variants) is what you want. If it comes back as a plain asset, you have an
individual mint, not the collection.

### Automating it

The repository ships this check:

```bash
NFT_COLLECTION_ID=<id> HELIUS_API_KEY=<key> pnpm run validate:collection <mintA> <mintB> <mintC>
```

It exits `0` on agreement and non-zero with an explanation otherwise. It reports
discrepancies but **never substitutes or infers a different id** — a wrong
`NFT_COLLECTION_ID` fails setup rather than silently gating on the wrong
collection.

---

## The reference collection: Solana Business Frogs

```
J7rxtKmEpNJEtrfkagiTF1gsmLyVus6BQZFY4ouBkeMG
```

Established as follows, and reproducible with the commands above:

| Check | Result |
| --- | --- |
| `getAsset` on four independently sourced SBF mints (#2663, #2965, #6503, #1839) | all four group to `J7rx…keMG` |
| `getAsset` on `J7rx…keMG` | `interface: MplCoreCollection`, name **Solana Business Frogs** |
| Verified creator on the collection | `fucK1fTHKvo4dsiAug26vsR8au3GH3HzDLA5R1ad1zp` — the same address that prefixes every member's metadata URI |
| `getAssetsByGroup` full enumeration | 9,873 live assets, every one named `Solana Business Frogs #N` and carrying that grouping |

The collection is **MPL Core**, not Token Metadata. This changes nothing in the
application: DAS presents both through the same `grouping` model and the same
`searchAssets` query.

---

## Ownership queries

```json
{
  "jsonrpc": "2.0",
  "id": "ownership-check",
  "method": "searchAssets",
  "params": {
    "ownerAddress": "<wallet>",
    "tokenType": "nonFungible",
    "grouping": ["collection", "<NFT_COLLECTION_ID>"],
    "page": 1,
    "limit": 1
  }
}
```

Notes that matter in practice:

- Valid `tokenType` values are `fungible`, `nonFungible`, `regularNFT`,
  `compressedNFT`, `all`. `nonFungible` correctly matches MPL Core assets.
- With `limit: 1`, the response's `total` is the size of the returned **page**,
  not the wallet's holdings. It is a valid boolean gate, but must never be shown
  to a user as "you own N". Use `countOwned()` when a real count is needed.
- Responses arrive as `result: { items }` and, with some display options, as
  `result: { assets: { items } }`. Both shapes are accepted.
- Returned items are re-filtered locally against the configured collection id.

### Failure handling

Ownership is **tri-state**, and this is the single most important behaviour in
the codebase:

| Condition | Result |
| --- | --- |
| ≥1 qualifying asset | `OWNED` |
| 0 qualifying assets | `NOT_OWNED` |
| timeout / abort | `INDETERMINATE` (`timeout`) |
| HTTP 429 or a rate-limit RPC error | `INDETERMINATE` (`rate_limited`) |
| any other non-2xx | `INDETERMINATE` (`http_<status>`) |
| JSON-RPC error | `INDETERMINATE` (`rpc_error`) |
| unparseable or unexpected body | `INDETERMINATE` (`malformed_response`) |
| network failure | `INDETERMINATE` (`network_error`) |

`INDETERMINATE` never revokes, never starts a grace period, and is never shown
to a user as "you don't hold one". The user-facing message says the indexer was
unreachable and that their access is unchanged.

---

## Wallet signature verification

The user signs a plain text message. **Never** a transaction, and never anything
involving a seed phrase or private key.

```
gate.example wants you to verify ownership with your Solana account:
<wallet>

Sign this message to prove you control this wallet and unlock access to the
<app> Telegram group.

This is not a transaction and will not move any funds.

App: <app name>
Telegram User ID: <telegram user id>
Wallet: <wallet>
Nonce: <256-bit random>
Issued At: <ISO-8601>
Expiration Time: <ISO-8601>
```

Every field the backend later relies on is inside the signed bytes, so changing
any of them invalidates the signature. That is what defeats:

| Attack | Why it fails |
| --- | --- |
| Replay | Nonce is single-use, burned by a conditional atomic `UPDATE` |
| Concurrent replay | Only one of two racing submissions can win that `UPDATE` |
| Expired reuse | `Expiration Time` is in the signed text and checked server-side |
| Wallet substitution | Challenge is bound to one wallet; submitting another is rejected before signature checking |
| Challenge substitution | Signature is verified against the server's stored challenge, not the client's copy |
| Stolen link | The Telegram user id is bound into both the link token and the challenge |
| Account sharing | A unique index allows one wallet per Telegram account |

Signature verification uses `@noble/curves`' ed25519 and returns `false` for any
malformed input rather than throwing, so exceptions cannot be used as an oracle
to distinguish "bad encoding" from "bad signature".

Ownership is only consulted **after** the signature has proven wallet control.
