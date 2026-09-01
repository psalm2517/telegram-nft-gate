import { isValidSolanaAddress, verifySignature } from '../lib/crypto.js';

export interface ChallengeParts {
  appName: string;
  domain: string;
  telegramUserId: string;
  walletAddress: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

/**
 * Human-readable challenge text, shown verbatim in the wallet's signing prompt.
 *
 * Every field the backend later relies on is inside the signed bytes, so a
 * signature captured for one user/wallet/app cannot be replayed for another:
 * swapping any of them changes the message and invalidates the signature.
 *
 * This is a plain message signature — never a transaction, and never a request
 * for a key or seed phrase.
 */
export function buildChallenge(parts: ChallengeParts): string {
  return [
    `${parts.domain} wants you to verify ownership with your Solana account:`,
    parts.walletAddress,
    '',
    `Sign this message to prove you control this wallet and unlock access to the ${parts.appName} Telegram group.`,
    '',
    'This is not a transaction and will not move any funds.',
    '',
    `App: ${parts.appName}`,
    `Telegram User ID: ${parts.telegramUserId}`,
    `Wallet: ${parts.walletAddress}`,
    `Nonce: ${parts.nonce}`,
    `Issued At: ${parts.issuedAt}`,
    `Expiration Time: ${parts.expiresAt}`,
  ].join('\n');
}

export interface SignatureCheckInput {
  /** The challenge exactly as persisted server-side. Never taken from the client. */
  challenge: string;
  signatureBase58: string;
  walletAddress: string;
}

/**
 * Verify that `walletAddress` produced `signatureBase58` over `challenge`.
 *
 * The challenge argument must come from the server's own record, not from the
 * request body — otherwise an attacker could sign a message of their choosing.
 */
export function verifyWalletSignature(input: SignatureCheckInput): boolean {
  if (!isValidSolanaAddress(input.walletAddress)) return false;
  const message = new TextEncoder().encode(input.challenge);
  return verifySignature(message, input.signatureBase58, input.walletAddress);
}

export { isValidSolanaAddress };
