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
} from 'lucide-react';
import {
  usersApi,
  type User,
  type Role,
  type CreateUserPayload,
  type UpdateUserPayload,
} from '@/api/users.api';

export default function UsersPage() {
  const [modalMode, setModalMode] = useState<'create' | 'edit' | null>(null);
  const [pwdUserId, setPwdUserId] = useState<string | null>(null);
  const [editUser, setEditUser] = useState<User | null>(null);

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
    </div>
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
