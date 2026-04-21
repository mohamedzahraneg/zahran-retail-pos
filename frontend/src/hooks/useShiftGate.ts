import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { shiftsApi } from '@/api/shifts.api';
import { useAuthStore } from '@/stores/auth.store';

const PROMPTED_KEY = 'zahran_shift_prompted';

/**
 * Once per login, if the user has no open shift, redirect to /shifts
 * so they open one (and register attendance) before using the system.
 *
 * Pages that are always allowed without a shift:
 *   /shifts, /login, /profile, /settings.
 */
export function useShiftGate() {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const isHydrated = useAuthStore((s) => s.isHydrated);
  const accessToken = useAuthStore((s) => s.accessToken);
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const didPromptRef = useRef(false);

  // Only users who can actually open a shift should be gated. Stock
  // keepers, accountants etc. can sign in, clock attendance and use
  // the rest of the system without being forced through /shifts.
  const canOpenShift = hasPermission('shifts.open');

  const { data: shift, isFetched } = useQuery({
    queryKey: ['current-shift'],
    queryFn: () => shiftsApi.current(),
    enabled: isHydrated && !!accessToken && canOpenShift,
    refetchInterval: 60_000,
  });

  useEffect(() => {
    if (!isHydrated || !accessToken) return;
    if (!canOpenShift) return; // no permission → no gate
    if (!isFetched) return;
    if (shift) {
      sessionStorage.removeItem(PROMPTED_KEY);
      return;
    }
    const allowed =
      pathname.startsWith('/shifts') ||
      pathname.startsWith('/login') ||
      pathname.startsWith('/profile') ||
      pathname.startsWith('/settings') ||
      pathname.startsWith('/me');
    if (allowed) return;
    if (didPromptRef.current) return;
    if (sessionStorage.getItem(PROMPTED_KEY)) return;
    didPromptRef.current = true;
    sessionStorage.setItem(PROMPTED_KEY, '1');
    toast('سجّل حضورك وافتح الوردية للبدء', {
      icon: '⏱️',
      duration: 5000,
    });
    navigate('/shifts?open=1', { replace: true });
  }, [
    isHydrated,
    accessToken,
    canOpenShift,
    isFetched,
    shift,
    pathname,
    search,
    navigate,
  ]);
}
