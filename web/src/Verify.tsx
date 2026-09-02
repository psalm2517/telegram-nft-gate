import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Wallet } from '@wallet-standard/base';
import {
  api,
  ApiError,
  consumeToken,
  type ChallengeResponse,
  type PublicConfig,
} from './lib/api';
import { fallbackUrlFor, isMobileBrowser, KNOWN_WALLETS } from './lib/knownWallets';
import {
  connectWallet,
  listCompatibleWallets,
  onWalletsChanged,
  shortAddress,
  signChallenge,
  type ConnectedWallet,
} from './lib/wallet';

type Step = 'connect' | 'sign' | 'checking' | 'done';

export function Verify() {
  // Captured from the URL fragment before first paint; the fragment is scrubbed
  // in the same step so the bearer token is not left in the address bar.
  const [token] = useState<string | null>(consumeToken);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [connected, setConnected] = useState<ConnectedWallet | null>(null);
  const [step, setStep] = useState<Step>('connect');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    api.get<PublicConfig>('/api/config').then(setConfig).catch(() => setConfig(null));
  }, []);

  useEffect(() => {
    const refresh = () => setWallets(listCompatibleWallets());
    refresh();
    return onWalletsChanged(refresh);
  }, []);

  const handleConnect = useCallback(async (wallet: Wallet) => {
    setError(null);
    setBusy(true);
    try {
      const result = await connectWallet(wallet);
      setConnected(result);
      setStep('sign');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect to that wallet.');
    } finally {
      setBusy(false);
    }
  }, []);

  const handleVerify = useCallback(async () => {
    if (!connected || !token) return;
    setError(null);
    setBusy(true);
    try {
      // 1. Ask the backend for a challenge bound to this Telegram user + wallet.
      const challenge = await api.post<ChallengeResponse>('/api/verify/challenge', {
        token,
        walletAddress: connected.address,
      });

      // 2. Sign it locally. No key material ever leaves the wallet.
      const signature = await signChallenge(connected, challenge.challenge);

      // 3. The backend re-verifies everything itself. Nothing here is trusted.
      setStep('checking');
      const result = await api.post<{ ok: boolean; message: string }>('/api/verify/submit', {
        token,
        walletAddress: connected.address,
        nonce: challenge.nonce,
        signature,
      });
      setSuccess(result.message);
      setStep('done');
    } catch (err) {
      setStep('sign');
      if (err instanceof ApiError) setError(err.message);
      else if (err instanceof Error) setError(err.message);
      else setError('Verification failed.');
    } finally {
      setBusy(false);
    }
  }, [connected, token]);

  const steps = useMemo(
    () => [
      { key: 'connect', label: 'Connect your Solana wallet' },
      { key: 'sign', label: 'Sign the verification message' },
      { key: 'checking', label: 'Confirm NFT ownership on-chain' },
      { key: 'done', label: 'Access granted in Telegram' },
    ],
    [],
  );
  const currentIndex = steps.findIndex((s) => s.key === step);

  if (!token) {
    return (
      <div className="wrap">
        <h1>Verification link required</h1>
        <div className="card">
          <p>
            This page can only be opened through the personal link the bot sends you.
          </p>
          <p className="muted">
            Open Telegram, message the bot, and send <span className="mono">/verify</span> to get
            a fresh link. Links expire after 15 minutes.
          </p>
        </div>
      </div>
    );
  }

  const heading = config?.groupTitle ?? config?.appName ?? 'NFT Gate';
  const bodyText = config?.groupTitle
    ? `Prove you control a wallet holding a qualifying NFT to join "${config.groupTitle}".`
    : 'Prove you control a wallet holding a qualifying NFT to unlock access.';

  return (
    <div className="wrap">
      <h1>{heading}</h1>
      <p className="muted">{bodyText}</p>

      <div className="card">
        <ul className="steps">
          {steps.map((s, i) => (
            <li key={s.key} className={i < currentIndex ? 'done' : i === currentIndex ? 'active' : ''}>
              <span className="dot">{i < currentIndex ? '✓' : i === currentIndex ? '▸' : '○'}</span>
              <span>{s.label}</span>
            </li>
          ))}
        </ul>
      </div>

      {error && <div className="notice err">{error}</div>}
      {success && <div className="notice ok">{success}</div>}

      {step === 'connect' && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Choose a wallet</h2>
          <div className="wallet-list">
            {KNOWN_WALLETS.map((known) => {
              const detected = wallets.find(
                (w) => w.name.toLowerCase() === known.name.toLowerCase(),
              );
              if (detected) {
                return (
                  <button
                    key={known.name}
                    className="wallet-btn"
                    disabled={busy}
                    onClick={() => void handleConnect(detected)}
                  >
                    {detected.icon ? (
                      <img src={detected.icon} alt="" />
                    ) : (
                      <span className="wallet-badge" style={{ background: known.color }}>
                        {known.badge}
                      </span>
                    )}
                    <span>{known.name}</span>
                  </button>
                );
              }
              return (
                <a
                  key={known.name}
                  className="wallet-btn wallet-btn-fallback"
                  href={fallbackUrlFor(known)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="wallet-badge" style={{ background: known.color }}>
                    {known.badge}
                  </span>
                  <span>{known.name}</span>
                  <span className="muted wallet-btn-hint">
                    {isMobileBrowser() ? 'Open in app' : 'Install'}
                  </span>
                </a>
              );
            })}
            {wallets
              .filter((w) => !KNOWN_WALLETS.some((k) => k.name.toLowerCase() === w.name.toLowerCase()))
              .map((w) => (
                <button
                  key={w.name}
                  className="wallet-btn"
                  disabled={busy}
                  onClick={() => void handleConnect(w)}
                >
                  {w.icon && <img src={w.icon} alt="" />}
                  <span>{w.name}</span>
                </button>
              ))}
          </div>
          <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
            Already have a wallet installed but don't see it? It'll appear above automatically
            once detected.
          </p>
        </div>
      )}

      {connected && step !== 'done' && (
        <div className="card">
          <p>
            Connected: <span className="mono">{shortAddress(connected.address)}</span>
          </p>
          <p className="muted">
            You will be asked to sign a short text message. This is <strong>not</strong> a
            transaction: it moves no funds and grants no spending permission. This site will never
            ask for a seed phrase or private key.
          </p>
          <div className="row">
            <button disabled={busy || step === 'checking'} onClick={() => void handleVerify()}>
              {step === 'checking' ? 'Checking ownership…' : 'Sign and verify'}
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                setConnected(null);
                setStep('connect');
                setError(null);
              }}
            >
              Use a different wallet
            </button>
          </div>
        </div>
      )}

      {step === 'done' && (
        <div className="card">
          <p>Return to your Telegram chat with the bot — your invite link is waiting there.</p>
          <p className="muted">
            The invite link is single-use and expires shortly, so use it soon.
          </p>
        </div>
      )}

      {config && (
        <p className="muted mono" style={{ marginTop: 24 }}>
          Collection: {config.collectionId}
        </p>
      )}
    </div>
  );
}
