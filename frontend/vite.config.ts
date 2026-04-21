/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    resolve: {
      alias: { '@': path.resolve(__dirname, 'src') },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      css: false,
    },
    server: {
      host: true,
      port: 5173,
      proxy: {
        '/api': {
          target: env.VITE_API_URL || 'http://localhost:3000',
          changeOrigin: true,
        },
      },
    },
    preview: { host: true, port: 4173 },
    // vite-plugin-pwa is temporarily disabled. A static kill-switch
    // service worker lives in public/sw.js — it unregisters itself on
    // every visit so lingering precaches from earlier builds stop
    // causing white screens after deploys. Once the population has
    // churned through this SW we can reintroduce PWA cleanly.
    plugins: [react()],
    build: {
      target: 'es2020',
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 1200,
    },
  };
});
