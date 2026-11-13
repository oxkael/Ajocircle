import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // near-api-js includes Node's debug/callbackify helpers in its browser bundle.
  // Replace the tiny process APIs those helpers use so they work in browsers.
  define: {
    'process.env.NODE_DEBUG': '""',
    'process.nextTick': 'queueMicrotask',
  },
  server: {
    port: 5181,
    strictPort: true,
    host: true,
  },
});
