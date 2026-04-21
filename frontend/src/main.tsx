import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { Toaster } from 'react-hot-toast';
import { BrowserRouter } from 'react-router-dom';

import App from './App';
import './styles/index.css';
import { startAutoSync } from '@/lib/offline-queue';

// Kick off background sync of pending offline invoices
startAutoSync();

// PWA is temporarily disabled (see vite.config.ts). If an old
// Workbox service worker is still registered on this origin, tell the
// browser to evict it — /sw.js is now a kill-switch that unregisters
// itself and clears every Cache-Storage entry. Auto-reloads the tab
// on controller change so the user lands on a SW-less page.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((regs) => {
      regs.forEach((r) => r.update().catch(() => {}));
    })
    .catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
      <Toaster
        position="top-left"
        toastOptions={{
          style: {
            fontFamily: 'Cairo, sans-serif',
            fontWeight: 600,
          },
        }}
      />
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  </React.StrictMode>,
);
