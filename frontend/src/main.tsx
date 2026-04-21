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

// Register the custom offline service worker (public/sw.js). It uses
// NetworkFirst for navigations and the API, CacheFirst for hashed
// /assets, and never precaches index.html so new deploys always
// serve a fresh HTML shell when online.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch(() => {
        /* SW registration failure isn't fatal — site still works */
      });
  });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      // Don't retry when the browser has no network — every attempt
      // just adds another ERR_INTERNET_DISCONNECTED to the console.
      retry: (failureCount, _error) => {
        if (!navigator.onLine) return false;
        return failureCount < 2;
      },
      // Pause polling while offline so the console stays quiet and
      // the battery isn't drained by hopeless retries. Resumes
      // automatically when the browser reconnects.
      refetchIntervalInBackground: false,
      networkMode: 'offlineFirst',
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
