import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { useRealtime } from '@/hooks/useRealtime';

interface Props {
  title: string;
}

export function AppLayout({ title }: Props) {
  // Open the realtime socket for the signed-in session.
  useRealtime();

  return (
    <div className="flex min-h-screen bg-slate-50" dir="rtl">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0">
        <Topbar title={title} />
        <div className="flex-1 p-3 md:p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
