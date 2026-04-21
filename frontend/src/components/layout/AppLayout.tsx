import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { useRealtime } from '@/hooks/useRealtime';
import { useShiftGate } from '@/hooks/useShiftGate';

interface Props {
  title: string;
}

export function AppLayout({ title }: Props) {
  // Open the realtime socket for the signed-in session.
  useRealtime();
  // First action after login: make sure a shift is open (also triggers
  // attendance check-in on the shifts page).
  useShiftGate();
  const { pathname } = useLocation();
  // POS is a full-screen workspace — hide the top bar and inner padding
  const fullscreen = pathname === '/pos';

  return (
    <div className="flex min-h-screen bg-slate-50" dir="rtl">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0">
        {!fullscreen && <Topbar title={title} />}
        <div className={fullscreen ? 'flex-1' : 'flex-1 p-3 md:p-6'}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}
