import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Users as UsersIcon,
  Plus,
  Pencil,
  KeyRound,
  Power,
  PowerOff,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  usersApi,
  type User,
  type Role,
  type CreateUserPayload,
  type UpdateUserPayload,
} from '@/api/users.api';
import { settingsApi } from '@/api/settings.api';

export default function UsersPage() {
  const [modalMode, setModalMode] = useState<'create' | 'edit' | null>(null);
  const [pwdUserId, setPwdUserId] = useState<string | null>(null);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [permsUser, setPermsUser] = useState<User | null>(null);

  const qc = useQueryClient();

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: usersApi.list,
  });

  const { data: roles = [] } = useQuery({
    queryKey: ['users-roles'],
    queryFn: usersApi.roles,
  });

  const roleById = (id?: string) => roles.find((r) => r.id === id);

  const deactivate = useMutation({
    mutationFn: usersApi.deactivate,
    onSuccess: () => {
      toast.success('تم تعطيل المستخدم');
      qc.invalidateQueries({ queryKey: ['users'] });
    },
  });

  const activate = useMutation({
    mutationFn: usersApi.activate,
    onSuccess: () => {
      toast.success('تم تفعيل المستخدم');
      qc.invalidateQueries({ queryKey: ['users'] });
    },
  });

  return (
    <div className="p-6 space-y-6" dir="rtl">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <UsersIcon className="w-6 h-6 text-pink-500" />
            إدارة المستخدمين
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            إضافة وتعديل موظفي النظام وصلاحياتهم
          </p>
        </div>
        <button
          onClick={() => {
            setEditUser(null);
            setModalMode('create');
          }}
          className="btn-primary flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          إضافة مستخدم
        </button>
      </header>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="p-10 text-center text-slate-400">جاري التحميل…</div>
        ) : users.length === 0 ? (
          <div className="p-10 text-center text-slate-400">
            لا يوجد مستخدمون بعد
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-900/60 text-slate-400">
              <tr>
                <th className="p-3 text-right">الاسم</th>
                <th className="p-3 text-right">اسم المستخدم</th>
                <th className="p-3 text-right">الدور</th>
                <th className="p-3 text-right">البريد</th>
                <th className="p-3 text-right">الهاتف</th>
                <th className="p-3 text-right">آخر دخول</th>
                <th className="p-3 text-right">الحالة</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-slate-900/40">
                  <td className="p-3 font-medium">
                    {u.full_name || '—'}
                  </td>
                  <td className="p-3 font-mono text-xs">{u.username}</td>
                  <td className="p-3">{roleById(u.role_id)?.name_ar || '—'}</td>
                  <td className="p-3 text-slate-400">{u.email || '—'}</td>
                  <td className="p-3 text-slate-400">{u.phone || '—'}</td>
                  <td className="p-3 text-xs text-slate-400">
                    {u.last_login_at
                      ? new Date(u.last_login_at).toLocaleString('en-US')
                      : 'لم يسجل دخول'}
                  </td>
                  <td className="p-3">
                    {u.is_active ? (
                      <span className="badge-success">نشط</span>
                    ) : (
                      <span className="badge-muted">معطل</span>
                    )}
                  </td>
                  <td className="p-3">
                    <div className="flex items-center gap-1 justify-end">
                      <button
                        title="تعديل"
                        onClick={() => {
                          setEditUser(u);
                          setModalMode('edit');
                        }}
                        className="icon-btn"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        title="تغيير كلمة المرور"
                        onClick={() => setPwdUserId(u.id)}
                        className="icon-btn"
                      >
                        <KeyRound className="w-4 h-4" />
                      </button>
                      <button
                        title="صلاحيات مخصصة"
                        onClick={() => setPermsUser(u)}
                        className="icon-btn text-indigo-400"
                      >
                        <ShieldCheck className="w-4 h-4" />
                      </button>
                      {u.is_active ? (
                        <button
                          title="تعطيل"
                          onClick={() => deactivate.mutate(u.id)}
                          className="icon-btn text-amber-400"
                        >
                          <PowerOff className="w-4 h-4" />
                        </button>
                      ) : (
                        <button
                          title="تفعيل"
                          onClick={() => activate.mutate(u.id)}
                          className="icon-btn text-emerald-400"
                        >
                          <Power className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {modalMode && (
        <UserModal
          mode={modalMode}
          user={editUser}
          roles={roles}
          onClose={() => setModalMode(null)}
        />
      )}

      {pwdUserId && (
        <PasswordModal
          userId={pwdUserId}
          onClose={() => setPwdUserId(null)}
        />
      )}

      {permsUser && (
        <UserPermissionsModal
          user={permsUser}
          role={roleById(permsUser.role_id) || null}
          onClose={() => setPermsUser(null)}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function UserPermissionsModal({
  user,
  role,
  onClose,
}: {
  user: User;
  role: Role | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: perms } = useQuery({
    queryKey: ['permissions-catalog'],
    queryFn: () => settingsApi.listPermissions(),
  });
  const { data: fullUser } = useQuery({
    queryKey: ['user', user.id],
    queryFn: () => usersApi.get(user.id),
  });
  const { data: fullRole } = useQuery({
    queryKey: ['role', role?.id],
    queryFn: async () => {
      if (!role) return null;
      const all = await settingsApi.listRoles();
      return all.find((r: any) => r.id === role.id) || null;
    },
    enabled: !!role,
  });

  const rolePerms: string[] = (fullRole as any)?.permissions || [];
  const [extra, setExtra] = useState<Set<string>>(
    new Set(fullUser?.extra_permissions || []),
  );
  const [denied, setDenied] = useState<Set<string>>(
    new Set(fullUser?.denied_permissions || []),
  );

  // Re-sync when fresh user data arrives
  useState(() => {
    if (fullUser) {
      setExtra(new Set(fullUser.extra_permissions || []));
      setDenied(new Set(fullUser.denied_permissions || []));
    }
  });

  const save = useMutation({
    mutationFn: () =>
      usersApi.setPermissions(user.id, {
        extra_permissions: Array.from(extra),
        denied_permissions: Array.from(denied),
      }),
    onSuccess: () => {
      toast.success('تم حفظ الصلاحيات');
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['user', user.id] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'تعذر الحفظ'),
  });

  const effectiveState = (code: string): 'granted' | 'denied' | 'inherited' | 'off' => {
    if (denied.has(code)) return 'denied';
    if (extra.has(code)) return 'granted';
    if (rolePerms.includes('*') || rolePerms.includes(code)) return 'inherited';
    return 'off';
  };

  const cycleState = (code: string) => {
    const state = effectiveState(code);
    const newExtra = new Set(extra);
    const newDenied = new Set(denied);
    if (state === 'inherited') {
      // from role-granted → deny explicitly
      newDenied.add(code);
      newExtra.delete(code);
    } else if (state === 'off') {
      // not granted at all → add as extra
      newExtra.add(code);
      newDenied.delete(code);
    } else if (state === 'granted') {
      // extra-granted → remove (back to off)
      newExtra.delete(code);
      newDenied.delete(code);
    } else {
      // denied → remove denial (back to inherited/off)
      newDenied.delete(code);
      newExtra.delete(code);
    }
    setExtra(newExtra);
    setDenied(newDenied);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="modal-panel w-full max-w-3xl space-y-4 max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-indigo-500" />
              صلاحيات: {user.full_name || user.username}
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              الدور: <b>{role?.name_ar || '—'}</b> — اضغط على الصلاحية للتبديل
              بين (مورَّث / منح إضافي / حجب).
            </p>
          </div>
          <button onClick={onClose} className="icon-btn">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex flex-wrap gap-3 text-xs">
          <Legend color="emerald" label="مورَّث من الدور" />
          <Legend color="indigo" label="منح إضافي" />
          <Legend color="rose" label="محجوب (حتى لو الدور يعطيه)" />
          <Legend color="slate" label="غير مفعّل" />
        </div>

        {!perms ? (
          <div className="p-10 text-center text-slate-400">جاري التحميل…</div>
        ) : (
          Object.entries(perms.groups).map(([group, items]) => (
            <div key={group} className="card p-3">
              <div className="font-bold text-slate-700 mb-2">{group}</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {items.map((p) => {
                  const s = effectiveState(p.code);
                  const cls =
                    s === 'inherited'
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                      : s === 'granted'
                        ? 'border-indigo-300 bg-indigo-50 text-indigo-800'
                        : s === 'denied'
                          ? 'border-rose-300 bg-rose-50 text-rose-800 line-through'
                          : 'border-slate-200 bg-white text-slate-600';
                  return (
                    <button
                      key={p.code}
                      type="button"
                      onClick={() => cycleState(p.code)}
                      className={`text-right border rounded-lg px-3 py-2 text-sm transition ${cls}`}
                    >
                      <div className="font-bold">{p.label}</div>
                      <div className="text-[10px] font-mono opacity-70">
                        {p.code}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="btn-ghost">
            إلغاء
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="btn-primary"
          >
            حفظ
          </button>
        </div>
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  const cls =
    color === 'emerald'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
      : color === 'indigo'
        ? 'border-indigo-300 bg-indigo-50 text-indigo-800'
        : color === 'rose'
          ? 'border-rose-300 bg-rose-50 text-rose-800'
          : 'border-slate-200 bg-slate-50 text-slate-600';
  const dot =
    color === 'emerald'
      ? 'bg-emerald-500'
      : color === 'indigo'
        ? 'bg-indigo-500'
        : color === 'rose'
          ? 'bg-rose-500'
          : 'bg-slate-400';
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-xs ${cls}`}
    >
      <span className={`inline-block w-2 h-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

/* -------------------------------------------------------------------------- */

function UserModal({
  mode,
  user,
  roles,
  onClose,
}: {
  mode: 'create' | 'edit';
  user: User | null;
  roles: Role[];
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    username: user?.username || '',
    password: '',
    full_name: user?.full_name || '',
    email: user?.email || '',
    phone: user?.phone || '',
    role_id: user?.role_id || roles[0]?.id || '',
  });
  const qc = useQueryClient();

  const createMut = useMutation({
    mutationFn: (payload: CreateUserPayload) => usersApi.create(payload),
    onSuccess: () => {
      toast.success('تم إنشاء المستخدم');
      qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
  });

  const updateMut = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: UpdateUserPayload }) =>
      usersApi.update(id, payload),
    onSuccess: () => {
      toast.success('تم تحديث بيانات المستخدم');
      qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'create') {
      if (!form.username || !form.password) {
        toast.error('اسم المستخدم وكلمة المرور مطلوبان');
        return;
      }
      createMut.mutate(form);
    } else if (user) {
      const { password: _pw, username: _un, ...rest } = form;
      updateMut.mutate({ id: user.id, payload: rest });
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="modal-panel w-full max-w-md space-y-4"
      >
        <h2 className="text-lg font-bold">
          {mode === 'create' ? 'إضافة مستخدم' : 'تعديل المستخدم'}
        </h2>

        <div className="space-y-3">
          <div>
            <label className="label">الاسم الكامل</label>
            <input
              className="input"
              value={form.full_name}
              onChange={(e) =>
                setForm({ ...form, full_name: e.target.value })
              }
            />
          </div>
          <div>
            <label className="label">اسم المستخدم *</label>
            <input
              className="input"
              disabled={mode === 'edit'}
              value={form.username}
              onChange={(e) =>
                setForm({ ...form, username: e.target.value })
              }
            />
          </div>
          {mode === 'create' && (
            <div>
              <label className="label">كلمة المرور *</label>
              <input
                type="password"
                className="input"
                value={form.password}
                onChange={(e) =>
                  setForm({ ...form, password: e.target.value })
                }
              />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">البريد الإلكتروني</label>
              <input
                type="email"
                className="input"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </div>
            <div>
              <label className="label">رقم الهاتف</label>
              <input
                className="input"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            </div>
          </div>
          <div>
            <label className="label">الدور</label>
            <select
              className="input"
              value={form.role_id}
              onChange={(e) => setForm({ ...form, role_id: e.target.value })}
            >
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name_ar}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-ghost">
            إلغاء
          </button>
          <button
            type="submit"
            disabled={createMut.isPending || updateMut.isPending}
            className="btn-primary"
          >
            حفظ
          </button>
        </div>
      </form>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function PasswordModal({
  userId,
  onClose,
}: {
  userId: string;
  onClose: () => void;
}) {
  const [pwd, setPwd] = useState('');
  const [confirm, setConfirm] = useState('');

  const mutation = useMutation({
    mutationFn: (pw: string) => usersApi.changePassword(userId, pw),
    onSuccess: () => {
      toast.success('تم تغيير كلمة المرور');
      onClose();
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pwd.length < 6) {
      toast.error('كلمة المرور يجب أن تكون 6 أحرف على الأقل');
      return;
    }
    if (pwd !== confirm) {
      toast.error('كلمتا المرور غير متطابقتين');
      return;
    }
    mutation.mutate(pwd);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="modal-panel w-full max-w-sm space-y-4"
      >
        <h2 className="text-lg font-bold flex items-center gap-2">
          <KeyRound className="w-5 h-5 text-pink-500" />
          تغيير كلمة المرور
        </h2>
        <div className="space-y-3">
          <div>
            <label className="label">كلمة المرور الجديدة</label>
            <input
              type="password"
              className="input"
              value={pwd}
              onChange={(e) => setPwd(e.target.value)}
            />
          </div>
          <div>
            <label className="label">تأكيد كلمة المرور</label>
            <input
              type="password"
              className="input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-ghost">
            إلغاء
          </button>
          <button
            type="submit"
            disabled={mutation.isPending}
            className="btn-primary"
          >
            حفظ
          </button>
        </div>
      </form>
    </div>
  );
}
