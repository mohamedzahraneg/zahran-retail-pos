import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Bell, CheckCircle2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { employeesApi, EmployeeTask } from '@/api/employees.api';
import { useAuthStore } from '@/stores/auth.store';

/**
 * Floating popup that surfaces unacknowledged tasks to every signed-in
 * employee. Mounts once in AppLayout. Poll every minute.
 *
 * Behavior:
 *   • If there are "pending" (never-seen) tasks, a blocking dialog
 *     opens until the employee clicks "استلمت المهمة".
 *   • Acknowledged-but-incomplete tasks render as a small floating
 *     chip at the bottom-right corner so they stay visible as
 *     persistent reminders until completed.
 */
export function EmployeeTaskPopup() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canSee = !!accessToken && hasPermission('employee.dashboard.view');
  const qc = useQueryClient();
  const [dismissedBar, setDismissedBar] = useState<Set<string>>(new Set());

  const { data: tasks = [] } = useQuery({
    queryKey: ['employee-my-tasks'],
    queryFn: () => employeesApi.myTasks(),
    enabled: canSee,
    refetchInterval: 60_000,
  });

  const ack = useMutation({
    mutationFn: (id: string) => employeesApi.ackTask(id),
    onSuccess: () => {
      toast.success('تم الاستلام — ستبقى المهمة ظاهرة حتى اكتمالها');
      qc.invalidateQueries({ queryKey: ['employee-my-tasks'] });
      qc.invalidateQueries({ queryKey: ['employee-dashboard'] });
    },
  });
  const done = useMutation({
    mutationFn: (id: string) => employeesApi.completeTask(id),
    onSuccess: () => {
      toast.success('تم إنهاء المهمة');
      qc.invalidateQueries({ queryKey: ['employee-my-tasks'] });
      qc.invalidateQueries({ queryKey: ['employee-dashboard'] });
    },
  });

  if (!canSee) return null;

  const openTasks = tasks.filter(
    (t: EmployeeTask) => t.status === 'pending' || t.status === 'acknowledged',
  );
  const unacked = openTasks.filter((t) => t.status === 'pending');
  const acked = openTasks.filter((t) => t.status === 'acknowledged');
  const barVisible = acked.filter((t) => !dismissedBar.has(t.id));

  return (
    <>
      {/* Blocking modal for unacknowledged tasks — user must click
          "استلمت" to continue working in the app. */}
      {unacked.length > 0 && (
        <div className="fixed inset-0 z-[70] bg-slate-900/70 flex items-center justify-center p-4">
          <div
            className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden"
            dir="rtl"
          >
            <div className="p-4 bg-gradient-to-r from-rose-500 to-amber-500 text-white flex items-center gap-2">
              <Bell size={20} />
              <div>
                <div className="font-black">مهمة جديدة من الإدارة</div>
                <div className="text-[11px] opacity-90">
                  {unacked.length > 1
                    ? `لديك ${unacked.length} مهام في انتظار الاستلام`
                    : 'اقرأ المهمة وأكّد الاستلام للمتابعة'}
                </div>
              </div>
            </div>
            <div className="p-4 max-h-[60vh] overflow-y-auto space-y-3">
              {unacked.map((t) => (
                <div
                  key={t.id}
                  className="border border-slate-200 rounded-lg p-3 bg-slate-50"
                >
                  <div className="font-black text-slate-800 mb-1">{t.title}</div>
                  {t.description && (
                    <div className="text-xs text-slate-600 mb-2 whitespace-pre-wrap">
                      {t.description}
                    </div>
                  )}
                  {t.due_at && (
                    <div className="text-[11px] text-amber-700 mb-2">
                      مطلوب قبل: {new Date(t.due_at).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' })}
                    </div>
                  )}
                  <button
                    className="btn-primary w-full text-xs py-2"
                    onClick={() => ack.mutate(t.id)}
                    disabled={ack.isPending}
                  >
                    <CheckCircle2 size={14} /> استلمت المهمة
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Persistent reminders — visible everywhere until the task is
          completed. The employee can "تم" to mark completion. */}
      {barVisible.length > 0 && (
        <div className="fixed bottom-4 left-4 z-[60] w-[min(320px,calc(100vw-2rem))] space-y-2">
          {barVisible.map((t) => (
            <div
              key={t.id}
              className="bg-white border border-amber-300 shadow-lg rounded-xl p-3 text-xs"
            >
              <div className="flex items-start gap-2">
                <Bell className="text-amber-600 flex-shrink-0" size={16} />
                <div className="flex-1 min-w-0">
                  <div className="font-black text-slate-800 truncate">
                    {t.title}
                  </div>
                  {t.description && (
                    <div className="text-slate-600 line-clamp-2">
                      {t.description}
                    </div>
                  )}
                </div>
                <button
                  className="text-slate-400 hover:text-slate-600"
                  onClick={() =>
                    setDismissedBar((s) => new Set(s).add(t.id))
                  }
                  title="إخفاء"
                >
                  <X size={14} />
                </button>
              </div>
              <div className="flex gap-2 mt-2 justify-end">
                <button
                  className="btn-ghost border border-emerald-200 text-emerald-700 text-[11px] py-1"
                  disabled={done.isPending}
                  onClick={() => done.mutate(t.id)}
                >
                  تم الإنجاز
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
