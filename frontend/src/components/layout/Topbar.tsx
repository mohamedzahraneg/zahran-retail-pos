import { useEffect, useState } from 'react';
import { Bell, Wifi, WifiOff, Menu } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { alertsApi } from '@/api/alerts.api';
import { useLayoutStore } from '@/stores/layout.store';
import { PrayerStrip } from './PrayerStrip';

export function Topbar({ title: _title }: { title: string }) {
  const [online, setOnline] = useState(navigator.onLine);
  const navigate = useNavigate();
  const openMobile = useLayoutStore((s) => s.openMobile);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const { data: counts } = useQuery({
    queryKey: ['alerts-counts'],
    queryFn: alertsApi.counts,
    refetchInterval: 30_000,
  });

  const unread = counts?.unread ?? 0;
  const critical = counts?.critical ?? 0;

  return (
    <header className="h-14 md:h-16 bg-white border-b border-slate-200 px-3 md:px-6 flex items-center justify-between sticky top-0 z-30">
      <div className="flex items-center gap-2 md:gap-4 min-w-0 flex-1">
        <button
          onClick={openMobile}
          className="p-2 rounded-lg hover:bg-slate-100 text-slate-600 lg:hidden"
          aria-label="القائمة"
        >
          <Menu size={22} />
        </button>
        <PrayerStrip />
      </div>
      <div className="flex items-center gap-2 md:gap-4">
        <div
          className={
            online
              ? 'chip bg-emerald-50 text-emerald-700'
              : 'chip bg-amber-50 text-amber-700'
          }
        >
          {online ? <Wifi size={14} /> : <WifiOff size={14} />}
          <span className="hidden sm:inline">
            {online ? 'متصل' : 'بدون اتصال'}
          </span>
        </div>
        <button
          className="relative p-2 rounded-lg hover:bg-slate-100 text-slate-600"
          onClick={() => navigate('/alerts')}
          title="التنبيهات"
        >
          <Bell size={20} />
          {unread > 0 && (
            <span
              className={`absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] rounded-full text-[10px] font-bold text-white flex items-center justify-center px-1 ${
                critical > 0 ? 'bg-rose-500' : 'bg-amber-500'
              }`}
            >
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      </div>
    </header>
  );
}
