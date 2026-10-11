import { defineConfig, type Plugin } from 'vite';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

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

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), securityHeadersPlugin],
  server: {
    host: '0.0.0.0',
    proxy: {
      '/v1': { target: 'http://localhost:3001', changeOrigin: true, secure: false },
      // identity 8 (Better Auth): sign-in, the Microsoft callback and sign-out, same-origin with the SPA.
      '/api/auth': { target: 'http://localhost:3001', changeOrigin: true, secure: false },
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
