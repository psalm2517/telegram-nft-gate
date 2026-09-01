import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  build: {
    // Emitted into the directory the Worker serves as static assets.
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    // Local-only convenience: `vite dev` proxies the API to `wrangler dev`.
    // In production everything is same-origin on the Worker, so no proxy exists.
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
});
