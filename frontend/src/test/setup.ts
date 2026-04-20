import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

// Silence the service worker registration that PWA plugins sometimes try
// during tests.
(globalThis as any).navigator ||= {};
if (!(globalThis as any).navigator.serviceWorker) {
  (globalThis as any).navigator.serviceWorker = {
    register: () => Promise.resolve(),
  };
}
