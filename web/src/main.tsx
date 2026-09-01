import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Verify } from './Verify';
import './styles.css';

/**
 * One page. There is no client-side router because there is only one route:
 * the Worker's `not_found_handling: "single-page-application"` sends every
 * non-API path here, and `/verify` is the only link the bot ever sends out.
 * Administration is entirely bot commands — see src/bot/bot.ts.
 */
function App() {
  const path = window.location.pathname;
  if (path.startsWith('/verify')) return <Verify />;

  return (
    <div className="wrap">
      <h1>NFT-gated Telegram access</h1>
      <div className="card">
        <p>
          This site verifies Solana NFT ownership for a private Telegram group.
        </p>
        <p className="muted">
          To get started, message the group's Telegram bot and send{' '}
          <span className="mono">/verify</span>. It will send you a personal link to this site.
        </p>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>);
