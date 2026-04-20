import { FormEvent, useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { LogIn, User, Lock } from 'lucide-react';
import toast from 'react-hot-toast';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/auth.store';
import { setupApi } from '@/api/setup.api';

export default function Login() {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const login = useAuthStore((s) => s.login);
  const nav = useNavigate();
  const loc = useLocation() as any;
  const from = loc.state?.from?.pathname || '/';

  // First-run: if system hasn't been set up yet, redirect to the setup wizard.
  const { data: setupStatus } = useQuery({
    queryKey: ['setup-status'],
    queryFn: () => setupApi.status(),
    retry: false,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (setupStatus?.needs_setup) {
      nav('/setup', { replace: true });
    }
  }, [setupStatus, nav]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await login(username, password);
      toast.success('مرحباً بك 👋');
      nav(from, { replace: true });
    } catch (err: any) {
      // interceptor already showed toast; nothing else to do
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{
        background:
          'radial-gradient(1200px 600px at 10% -10%, rgba(236,72,153,.35), transparent 60%),' +
          'radial-gradient(1000px 500px at 110% 10%, rgba(139,92,246,.35), transparent 60%),' +
          'linear-gradient(180deg, #0b1020, #0a0f1e)',
      }}
      dir="rtl"
    >
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-500 to-purple-600 items-center justify-center text-white font-black text-3xl shadow-glow">
            ز
          </div>
          <h1 className="mt-4 text-3xl font-black text-white">نظام زهران</h1>
          <p className="text-slate-400 text-sm">سجّل الدخول لبدء العمل</p>
        </div>

        <form
          onSubmit={submit}
          className="bg-white/10 backdrop-blur border border-white/10 rounded-2xl p-6 space-y-4"
        >
          <div>
            <label className="block text-sm font-semibold text-white/80 mb-1">
              اسم المستخدم
            </label>
            <div className="relative">
              <User
                size={18}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
              />
              <input
                className="w-full pr-10 pl-3 py-2.5 rounded-lg bg-white/5 border border-white/10 text-white focus:outline-none focus:ring-2 focus:ring-brand-400"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold text-white/80 mb-1">
              كلمة المرور
            </label>
            <div className="relative">
              <Lock
                size={18}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
              />
              <input
                type="password"
                className="w-full pr-10 pl-3 py-2.5 rounded-lg bg-white/5 border border-white/10 text-white focus:outline-none focus:ring-2 focus:ring-brand-400"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full btn bg-gradient-to-r from-brand-500 to-purple-600 text-white py-2.5 font-bold shadow-glow disabled:opacity-50"
          >
            {loading ? 'جارٍ الدخول...' : (
              <>
                <LogIn size={18} />
                <span>دخول</span>
              </>
            )}
          </button>

          <p className="text-xs text-center text-slate-400 pt-2">
            نظام POS · زهران للأحذية والحقائب
          </p>
        </form>
      </div>
    </div>
  );
}
