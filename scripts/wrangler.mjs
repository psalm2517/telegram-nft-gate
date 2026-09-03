#!/usr/bin/env node
/**
 * Wrangler wrapper that picks the right config file, then hands off.
 *
 * Resource ids (D1 `database_id`, KV `id`) are the one piece of config that
 * cannot live in the dashboard the way vars and secrets do: `wrangler deploy`
 * treats its config file as the authoritative definition of the Worker,
 * bindings included, on every deploy. So they have to come from *somewhere* on
 * disk at deploy time. There are three legitimate somewheres, and hardcoding
 * any single one breaks the other two:
 *
 *   1. wrangler.local.jsonc  — gitignored. For anyone whose repo is also the
 *                              upstream template and so must keep real ids out
 *                              of the committed file.
 *   2. environment variables — for CI, which has no checked-out local file.
 *                              Substituted into a generated config below.
 *   3. wrangler.jsonc        — the committed file itself. This is the normal
 *                              case: fork the repo, paste your own ids in, and
 *                              everything below is inert.
 *
 * Usage: node scripts/wrangler.mjs <any wrangler args>
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const BASE = 'wrangler.jsonc';
const LOCAL = 'wrangler.local.jsonc';
const GENERATED = 'wrangler.generated.jsonc';

/** Placeholders in the committed config, replaced when ids come from the env. */
const D1_PLACEHOLDER = '00000000-0000-0000-0000-000000000000';
const KV_PLACEHOLDER = '00000000000000000000000000000000';

const env = (...names) => names.map((n) => process.env[n]).find((v) => v && v.trim());

function resolveConfig() {
  if (existsSync(LOCAL)) return LOCAL;

  const d1 = env('CF_D1_DATABASE_ID', 'D1_DATABASE_ID');
  const kv = env('CF_KV_NAMESPACE_ID', 'KV_NAMESPACE_ID');
  if (d1 && kv) {
    const config = readFileSync(BASE, 'utf8')
      .replaceAll(D1_PLACEHOLDER, d1)
      .replaceAll(KV_PLACEHOLDER, kv);
    writeFileSync(GENERATED, config);
    return GENERATED;
  }

  // Neither override is present, so the committed file is expected to carry
  // real ids. Warn if it still has placeholders: deploying that way fails
  // deep inside the Cloudflare API ("KV namespace '000…0' not found"), which
  // is a confusing way to find out you skipped a setup step.
  if (process.argv.includes('deploy') && !process.argv.includes('--dry-run')) {
    const base = readFileSync(BASE, 'utf8');
    if (base.includes(KV_PLACEHOLDER) || base.includes(D1_PLACEHOLDER)) {
      console.error(
        `\n${BASE} still has placeholder resource ids, so this deploy would fail.\n` +
          `Put your own ids in it (see docs/deployment.md), or supply them another way:\n` +
          `  - copy it to ${LOCAL} with real ids, to keep them out of git, or\n` +
          `  - set CF_D1_DATABASE_ID and CF_KV_NAMESPACE_ID, for CI.\n`,
      );
      process.exit(1);
    }
  }
  return BASE;
}

const config = resolveConfig();
const args = ['wrangler', '-c', config, ...process.argv.slice(2)];

spawn('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' }).on(
  'exit',
  (code) => process.exit(code ?? 1),
);
