import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

function readTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  if (document.documentElement.classList.contains('dark')) return 'dark';
  return (localStorage.getItem('theme') as Theme) || 'light';
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(readTheme);

  useEffect(() => {
    const mo = new MutationObserver(() => setThemeState(readTheme()));
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'theme') setThemeState(readTheme());
    };
    window.addEventListener('storage', onStorage);
    return () => {
      mo.disconnect();
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setTheme = (t: Theme) => {
    document.documentElement.classList.toggle('dark', t === 'dark');
    localStorage.setItem('theme', t);
    setThemeState(t);
  };

  return [theme, setTheme];
}
