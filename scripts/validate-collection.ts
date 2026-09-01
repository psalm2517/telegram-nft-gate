/**
 * Setup-time validation of NFT_COLLECTION_ID (CLAUDE.md §5).
 *
 * Confirms, against the live DAS API, that:
 *   1. the configured id resolves to a certified on-chain *collection* asset, and
 *   2. every sample mint you supply really groups to that id.
 *
 * This never discovers, infers or substitutes a different collection id. If the
 * configured value cannot be validated it reports the discrepancy and exits
 * non-zero, so a misconfiguration fails setup loudly instead of quietly gating
 * on the wrong collection.
 *
 * Usage:
 *   HELIUS_API_KEY=... NFT_COLLECTION_ID=... \
 *     node scripts/validate-collection.ts <mint> [<mint> ...]
 *
 * With no HELIUS_API_KEY set, pass --endpoint to use any DAS-compatible RPC.
 */
import { OwnershipChecker } from '../src/services/ownership.ts';

const args = process.argv.slice(2);
const endpointFlag = args.findIndex((a) => a === '--endpoint');
const endpoint = endpointFlag >= 0 ? args[endpointFlag + 1] : undefined;
const mints = args.filter((a, i) => !a.startsWith('--') && i !== endpointFlag + 1);

const collectionId = process.env.NFT_COLLECTION_ID;
const apiKey = process.env.HELIUS_API_KEY;

if (!collectionId) {
  console.error('NFT_COLLECTION_ID is not set.');
  process.exit(2);
}
if (!apiKey && !endpoint) {
  console.error('Set HELIUS_API_KEY, or pass --endpoint <url> for a DAS-compatible RPC.');
  process.exit(2);
}
if (mints.length === 0) {
  console.error(
    'Provide at least two known mint addresses from the collection so their\n' +
      'grouping metadata can be cross-checked against NFT_COLLECTION_ID.',
  );
  process.exit(2);
}

const checker = new OwnershipChecker({
  apiKey: apiKey ?? '',
  collectionId,
  ...(endpoint ? { endpoint } : {}),
  timeoutMs: 20_000,
});

const report = await checker.validateCollection(mints);

console.log(`\nConfigured NFT_COLLECTION_ID : ${report.collectionId}`);
console.log(`Resolved interface           : ${report.interface ?? '(unknown)'}`);
console.log(`Resolved collection name     : ${report.collectionName ?? '(none)'}\n`);

for (const sample of report.samples) {
  const mark = sample.belongs ? 'OK  ' : 'FAIL';
  const detail = sample.name ?? sample.reason ?? '';
  console.log(`  [${mark}] ${sample.mint}  ${detail}`);
}

if (report.ok) {
  console.log('\nValidated. All sample mints group to the configured collection id.');
  console.log('Confirm the resolved collection name is the collection you intend to gate on.');
  process.exit(0);
}

console.error('\nVALIDATION FAILED:');
for (const problem of report.problems) console.error(`  - ${problem}`);
console.error(
  '\nSetup should not continue. Fix NFT_COLLECTION_ID or the sample mints and re-run.\n' +
    'Do not substitute a different id based on this output.',
);
process.exit(1);
