import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { base58 } from '@scure/base';

/**
 * Minimal Solana Wallet Standard integration.
 *
 * We talk to the Wallet Standard registry directly rather than pulling in an
 * adapter framework: the app only needs "connect" and "sign a message", and
 * every Solana wallet that implements the standard exposes both.
 */

const CONNECT = 'standard:connect';
const SIGN_MESSAGE = 'solana:signMessage';
const SOLANA_MAINNET = 'solana:mainnet';

export interface ConnectedWallet {
  wallet: Wallet;
  account: WalletAccount;
  address: string;
}

interface ConnectFeature {
  connect(): Promise<{ accounts: readonly WalletAccount[] }>;
}

interface SignMessageFeature {
  signMessage(input: {
    account: WalletAccount;
    message: Uint8Array;
  }): Promise<readonly { signature: Uint8Array }[]>;
}

function hasFeature(wallet: Wallet, name: string): boolean {
  return name in wallet.features;
}

/** Wallets that can both connect and sign messages on a Solana chain. */
export function listCompatibleWallets(): Wallet[] {
  return getWallets()
    .get()
    .filter(
      (w) =>
        hasFeature(w, CONNECT) &&
        hasFeature(w, SIGN_MESSAGE) &&
        w.chains.some((c) => c.startsWith('solana:')),
    );
}

/** Subscribe to wallets registering after page load (common with extensions). */
export function onWalletsChanged(callback: () => void): () => void {
  const { on } = getWallets();
    const offRegister = on('register', callback);
  const offUnregister = on('unregister', callback);
  return () => {
    offRegister();
    offUnregister();
  };
}

/**
 * How long to wait for the wallet's own approval popup before giving up.
 *
 * A real approval prompt is answered in seconds. This exists for the failure
 * mode where the extension opens its popup anchored to the toolbar icon
 * (easy to miss) and then the user never notices it: without this, connect()
 * simply never resolves and the page looks permanently broken with no
 * feedback at all.
 */
const CONNECT_TIMEOUT_MS = 45_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

export async function connectWallet(wallet: Wallet): Promise<ConnectedWallet> {
  const feature = wallet.features[CONNECT] as ConnectFeature | undefined;
  if (!feature) throw new Error(`${wallet.name} does not support connecting.`);

  const { accounts } = await withTimeout(
    feature.connect(),
    CONNECT_TIMEOUT_MS,
    `${wallet.name} did not respond. Check for an approval popup: it sometimes opens ` +
      `near your browser's extension icon rather than on this page: then try again.`,
  );
  const account =
    accounts.find((a) => a.chains.includes(SOLANA_MAINNET)) ??
    accounts.find((a) => a.chains.some((c) => c.startsWith('solana:'))) ??
    accounts[0];

  if (!account) throw new Error(`${wallet.name} returned no accounts.`);
  if (!account.features.includes(SIGN_MESSAGE)) {
    throw new Error(`${wallet.name} cannot sign messages with this account.`);
  }
  return { wallet, account, address: account.address };
}

/**
 * Sign the server-issued challenge and return the signature as base58.
 *
 * The challenge text is passed through untouched: the backend verifies against
 * its own stored copy, so any local modification simply fails verification.
 */
export async function signChallenge(
  connected: ConnectedWallet,
  challenge: string,
): Promise<string> {
  const feature = connected.wallet.features[SIGN_MESSAGE] as SignMessageFeature | undefined;
  if (!feature) throw new Error('This wallet cannot sign messages.');

  const message = new TextEncoder().encode(challenge);
  const results = await feature.signMessage({ account: connected.account, message });
  const first = results[0];
  if (!first) throw new Error('The wallet returned no signature.');
  return base58.encode(first.signature);
}

export const shortAddress = (address: string): string =>
  address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
