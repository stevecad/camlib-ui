import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// `npm run dev` serves the interface with hot reload and sends /api to camlib-ui's server (python -m camlib_ui).
const api = process.env.CAMLIB_UI_API || 'http://127.0.0.1:8765';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { port: 5179, proxy: { '/api': { target: api, changeOrigin: false } } },
  build: {
    // The Python package serves the built interface (camlib_ui/web).
    outDir: fileURLToPath(new URL('../camlib_ui/web', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
    sourcemap: false,
  },
});
