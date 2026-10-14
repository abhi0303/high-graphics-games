import { defineConfig } from 'vite';

export default defineConfig({
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
