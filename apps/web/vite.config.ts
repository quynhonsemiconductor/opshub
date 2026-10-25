import { defineConfig, loadEnv, type Plugin } from 'vite';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The dev server's settings come from the root `.env` (where the API's PORT lives), read here because Vite only puts
// VITE_-prefixed keys into `import.meta.env`. The process environment wins, as usual. Defaults are the stack's own ports.
const dotenv = { ...loadEnv('', path.resolve(__dirname, '../..'), ''), ...process.env };
const apiOrigin = `http://localhost:${dotenv.PORT || 3001}`;

/** Dev-only security headers. Production sets these at the CDN / reverse proxy. */
const securityHeadersPlugin: Plugin = {
  name: 'security-headers',
  configureServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      next();
    });
  },
};

export default defineConfig(({ mode, command }) => ({
  // One root `.env` serves every process, the dev server included: `envDir` points Vite's own
  // VITE_* loading at the repo root (the same file `loadEnv` above already reads). Two safety
  // halves: Vite exposes only `VITE_`-prefixed keys to the browser, so the API's secrets in that
  // file never reach it; and the root file is read in DEV SERVE ONLY — `vite build` (any mode)
  // keeps the default envDir (apps/web), so a laptop's root flags cannot bake into a deployed
  // bundle. See the `[web]` section of .env.example for the flags the dev server picks up.
  envDir:
    command === 'serve' && mode === 'development' ? path.resolve(__dirname, '../..') : undefined,
  plugins: [react(), tailwindcss(), securityHeadersPlugin],
  server: {
    host: '0.0.0.0',
    // 5174 (WEB_DEV_PORT in .env) is the origin the rest of the stack is wired to: .env.example CORS_ORIGINS and APP_URL,
    // the Microsoft redirect URI, Garage's bucket CORS and Playwright's baseURL. strictPort: if another server holds it,
    // FAIL instead of silently moving to the next free port (5175 is rova's block, pending rova #742), where the sign-in redirect and bucket CORS would
    // no longer match.
    port: Number(dotenv.WEB_DEV_PORT) || 5174,
    strictPort: true,
    proxy: {
      '/v1': { target: apiOrigin, changeOrigin: true, secure: false },
      // identity 8 (Better Auth): sign-in, the Microsoft callback and sign-out, same-origin with the SPA.
      '/api/auth': { target: apiOrigin, changeOrigin: true, secure: false },
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  build: {
    sourcemap: mode === 'production' ? false : 'inline',
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'vendor-react';
          }
          if (id.includes('@tanstack/react-router')) return 'vendor-router';
          if (id.includes('@tanstack/react-query')) return 'vendor-query';
        },
      },
    },
  },
}));
