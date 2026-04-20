/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';
export default defineConfig(function (_a) {
    var mode = _a.mode;
    var env = loadEnv(mode, process.cwd(), '');
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
        plugins: [
            react(),
            VitePWA({
                registerType: 'autoUpdate',
                includeAssets: ['favicon.svg', 'icons/*.png'],
                manifest: {
                    name: 'زهران للبيع بالتجزئة',
                    short_name: 'زهران',
                    description: 'نظام نقاط البيع المتكامل',
                    theme_color: '#ec4899',
                    background_color: '#0b1020',
                    display: 'standalone',
                    orientation: 'any',
                    dir: 'rtl',
                    lang: 'ar',
                    scope: '/',
                    start_url: '/',
                    icons: [
                        { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
                        { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
                        {
                            src: 'icons/icon-512-maskable.png',
                            sizes: '512x512',
                            type: 'image/png',
                            purpose: 'maskable',
                        },
                    ],
                },
                workbox: {
                    globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
                    navigateFallback: '/index.html',
                    skipWaiting: true,
                    clientsClaim: true,
                    cleanupOutdatedCaches: true,
                    runtimeCaching: [
                        {
                            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com/,
                            handler: 'CacheFirst',
                            options: {
                                cacheName: 'google-fonts',
                                expiration: {
                                    maxEntries: 20,
                                    maxAgeSeconds: 60 * 60 * 24 * 365,
                                },
                            },
                        },
                        {
                            urlPattern: /\/api\/v1\/products.*/,
                            handler: 'StaleWhileRevalidate',
                            options: {
                                cacheName: 'api-products',
                                expiration: { maxAgeSeconds: 60 * 60 },
                            },
                        },
                        {
                            urlPattern: /\/api\/v1\/dashboard.*/,
                            handler: 'NetworkFirst',
                            options: {
                                cacheName: 'api-dashboard',
                                networkTimeoutSeconds: 3,
                            },
                        },
                    ],
                },
            }),
        ],
        build: {
            target: 'es2020',
            outDir: 'dist',
            sourcemap: false,
            chunkSizeWarningLimit: 1200,
        },
    };
});
