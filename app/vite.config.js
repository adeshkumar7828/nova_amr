import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// React source lives in web/, the build goes to web/dist (served by server/server.js).
// "npm run dev" = live-reload page on :5173 that talks to the Nova server on :8090.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    host: true,
    proxy: { '/ui': { target: 'ws://localhost:8090', ws: true } },
  },
});
