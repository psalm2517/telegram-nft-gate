/**
 * A curated fallback for wallets the Wallet Standard registry hasn't detected
 * (nothing installed, or a browser extension that hasn't injected yet).
 *
 * Wallet Standard can only ever list wallets already present in the page —
 * it has no concept of "not installed". Without this list, a visitor with no
 * extension sees an empty state and a vague "install something" message
 * instead of a recognizable button, which is what most wallet-gated sites
 * show instead.
 *
 * Deep links follow each wallet's own documented "Browse" universal link,
 * which opens the current page inside that wallet's in-app browser on
 * mobile (where the extension model doesn't apply at all) — at that point
 * Wallet Standard detects the wallet normally, because its own webview
 * injects the provider.
 */
export interface KnownWallet {
  name: string;
  /** Single letter/emoji shown in a colored badge in place of a fetched logo. */
  badge: string;
  color: string;
  installUrl: string;
  browseUrlBase: string;
}

export const KNOWN_WALLETS: KnownWallet[] = [
  {
    name: 'Phantom',
    badge: '👻',
    color: '#ab9ff2',
    installUrl: 'https://phantom.app/download',
    browseUrlBase: 'https://phantom.app/ul/browse',
  },
  {
    name: 'Solflare',
    badge: '🔆',
    color: '#fc8f3f',
    installUrl: 'https://solflare.com/download',
    browseUrlBase: 'https://solflare.com/ul/v1/browse',
  },
  {
    name: 'Backpack',
    badge: '🎒',
    color: '#e33e3f',
    installUrl: 'https://backpack.app/downloads',
    browseUrlBase: 'https://backpack.app/ul/v1/browse',
  },
];

export const isMobileBrowser = (): boolean =>
  typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/**
 * Where a click on a not-yet-detected wallet should go: on mobile, open this
 * page inside the wallet's own in-app browser (where it can inject itself);
 * on desktop, there is no in-app browser to speak of, so send them to install
 * the extension instead.
 */
export function fallbackUrlFor(wallet: KnownWallet): string {
  if (!isMobileBrowser()) return wallet.installUrl;
  const here = window.location.href;
  return `${wallet.browseUrlBase}/${encodeURIComponent(here)}?ref=${encodeURIComponent(here)}`;
}
