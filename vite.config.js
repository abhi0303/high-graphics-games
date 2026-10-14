import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves a project site under /<repo>/: the deploy workflow sets BASE_PATH.
  // Every runtime asset URL is built from import.meta.env.BASE_URL, so this is the only switch.
  base: process.env.BASE_PATH ?? '/',
  server: { port: 5173, strictPort: true },
  build: {
    target: 'es2022',
    // Rapier embeds its WASM (~2 MB) in JS; keep vendors in separate, cacheable chunks.
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          physics: ['@dimforge/rapier3d-compat'],
          post: ['postprocessing', 'n8ao'],
        },
      },
    },
  },
  optimizeDeps: {
    esbuildOptions: { target: 'es2022' },
  },
});
