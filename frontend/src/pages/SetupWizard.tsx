import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  UserPlus,
  Store,
  Warehouse,
  Star,
  Check,
  Loader2,
  ShieldCheck,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { setupApi, SetupInitPayload } from '@/api/setup.api';

type Step = 0 | 1 | 2 | 3 | 4;

const STEP_LABELS = [
  { label: 'مرحباً بك', icon: ShieldCheck },
  { label: 'الحساب الأول', icon: UserPlus },
  { label: 'معلومات المتجر', icon: Store },
  { label: 'المستودع الرئيسي', icon: Warehouse },
  { label: 'نقاط الولاء', icon: Star },
];

export default function SetupWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>(0);
  const [form, setForm] = useState<SetupInitPayload>({
    admin: { username: '', password: '', full_name: '', email: '', phone: '' },
    shop: {
      name: '',
      address: '',
      phone: '',
      tax_id: '',
      vat_number: '',
      footer_note: 'شكراً لتسوقك معنا',
    },
    warehouse: { code: 'MAIN', name: 'المستودع الرئيسي' },
    loyalty: {
      points_per_egp: 0.1,
      egp_per_point: 0.05,
      min_redeem: 100,
      max_redeem_ratio: 0.9,
    },
    currency: 'EGP',
    vat_rate: 0,
  });

  const { data: status, isLoading: loadingStatus } = useQuery({
    queryKey: ['setup-status'],
    queryFn: setupApi.status,
  });

  const initM = useMutation({
    mutationFn: () => setupApi.init(form),
    onSuccess: (res) => {
      toast.success(`تم الإعداد! سجّل الدخول بـ "${res.admin.username}"`);
      setTimeout(() => navigate('/login'), 1200);
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الإعداد'),
  });

  if (loadingStatus) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  if (status && !status.needs_setup) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 flex items-center justify-center p-4">
        <div className="card max-w-md w-full p-8 text-center space-y-4">
          <div className="w-16 h-16 rounded-full bg-emerald-100 text-emerald-600 mx-auto flex items-center justify-center">
            <Check size={32} />
          </div>
          <h2 className="text-2xl font-black">النظام جاهز!</h2>
          <p className="text-slate-600">
            تم إعداد النظام مسبقاً. الرجاء تسجيل الدخول للمتابعة.
          </p>
          <button
            className="btn-primary w-full"
            onClick={() => navigate('/login')}
          >
            تسجيل الدخول
          </button>
        </div>
      </div>
    );
  }

  const canNext = (): boolean => {
    switch (step) {
      case 1:
        return !!(
          form.admin.username &&
          form.admin.password &&
          form.admin.password.length >= 8 &&
          form.admin.full_name
        );
      case 2:
        return !!form.shop.name;
      case 3:
        return !!(form.warehouse.code && form.warehouse.name);
      default:
        return true;
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-50 via-slate-50 to-purple-50 flex items-center justify-center p-4">
      <div className="card max-w-2xl w-full overflow-hidden">
        {/* Progress bar */}
        <div className="px-6 pt-6">
          <div className="flex items-center justify-between mb-2">
            {STEP_LABELS.map((s, i) => {
              const Icon = s.icon;
              const done = i < step;
              const active = i === step;
              return (
                <div key={i} className="flex items-center flex-1">
                  <div className="flex flex-col items-center">
                    <div
                      className={`w-9 h-9 rounded-full flex items-center justify-center transition ${
                        done
                          ? 'bg-emerald-500 text-white'
                          : active
                            ? 'bg-brand-600 text-white shadow-glow'
                            : 'bg-slate-200 text-slate-500'
                      }`}
                    >
                      {done ? <Check size={16} /> : <Icon size={16} />}
                    </div>
                    <span
                      className={`text-[10px] mt-1 font-semibold ${
                        active ? 'text-brand-700' : 'text-slate-500'
                      }`}
                    >
                      {s.label}
                    </span>
                  </div>
                  {i < STEP_LABELS.length - 1 && (
                    <div
                      className={`flex-1 h-0.5 mx-1 ${
                        done ? 'bg-emerald-500' : 'bg-slate-200'
                      }`}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="p-6 min-h-[340px]">
          {step === 0 && (
            <div className="space-y-4 text-center py-8">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-500 to-purple-600 text-white mx-auto flex items-center justify-center font-black text-2xl shadow-glow">
                ز
              </div>
              <h1 className="text-3xl font-black text-slate-800">
                مرحباً بك في زهران
              </h1>
              <p className="text-slate-600 max-w-md mx-auto">
                قبل البدء، سنحتاج إلى إعداد حسابك كأدمن، معلومات متجرك،
                والمستودع الرئيسي. الإعداد يستغرق أقل من دقيقتين.
              </p>
              <div className="grid grid-cols-2 gap-3 max-w-md mx-auto pt-4">
                {[
                  { icon: UserPlus, label: 'حساب أدمن' },
                  { icon: Store, label: 'معلومات المتجر' },
                  { icon: Warehouse, label: 'المستودع' },
                  { icon: Star, label: 'نقاط الولاء' },
                ].map((f, i) => {
                  const Icon = f.icon;
                  return (
                    <div
                      key={i}
                      className="flex items-center gap-2 p-3 bg-slate-50 rounded-lg"
                    >
                      <Icon size={18} className="text-brand-600" />
                      <span className="text-sm font-semibold">{f.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-3">
              <h2 className="text-xl font-black mb-1">حساب المدير الأول</h2>
              <p className="text-sm text-slate-500 mb-4">
                هذا الحساب سيكون لديه كامل الصلاحيات على النظام.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">اسم المستخدم *</label>
                  <input
                    className="input font-mono"
                    value={form.admin.username}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        admin: { ...form.admin, username: e.target.value },
                      })
                    }
                    placeholder="admin"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="label">الاسم الكامل *</label>
                  <input
                    className="input"
                    value={form.admin.full_name}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        admin: { ...form.admin, full_name: e.target.value },
                      })
                    }
                    placeholder="أحمد محمد"
                  />
                </div>
              </div>
              <div>
                <label className="label">كلمة السر * (8 أحرف على الأقل)</label>
                <input
                  type="password"
                  className="input"
                  value={form.admin.password}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      admin: { ...form.admin, password: e.target.value },
                    })
                  }
                  placeholder="********"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">البريد الإلكتروني</label>
                  <input
                    type="email"
                    className="input"
                    value={form.admin.email}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        admin: { ...form.admin, email: e.target.value },
                      })
                    }
                  />
                </div>
                <div>
                  <label className="label">رقم الجوال</label>
                  <input
                    className="input font-mono"
                    value={form.admin.phone}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        admin: { ...form.admin, phone: e.target.value },
                      })
                    }
                    placeholder="+20100..."
                  />
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <h2 className="text-xl font-black mb-1">معلومات المتجر</h2>
              <p className="text-sm text-slate-500 mb-4">
                تظهر هذه المعلومات على إيصالات البيع.
              </p>
              <div>
                <label className="label">اسم المتجر *</label>
                <input
                  className="input"
                  value={form.shop.name}
                  onChange={(e) =>
                    setForm({ ...form, shop: { ...form.shop, name: e.target.value } })
                  }
                  placeholder="زهران — أحذية وحقائب"
                />
              </div>
              <div>
                <label className="label">العنوان</label>
                <input
                  className="input"
                  value={form.shop.address}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      shop: { ...form.shop, address: e.target.value },
                    })
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">تليفون المتجر</label>
                  <input
                    className="input font-mono"
                    value={form.shop.phone}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        shop: { ...form.shop, phone: e.target.value },
                      })
                    }
                  />
                </div>
                <div>
                  <label className="label">الرقم الضريبي</label>
                  <input
                    className="input font-mono"
                    value={form.shop.vat_number}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        shop: { ...form.shop, vat_number: e.target.value },
                      })
                    }
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">ضريبة القيمة المضافة (%)</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    className="input"
                    value={form.vat_rate}
                    onChange={(e) =>
                      setForm({ ...form, vat_rate: parseFloat(e.target.value) || 0 })
                    }
                  />
                </div>
                <div>
                  <label className="label">العملة</label>
                  <input
                    className="input font-mono"
                    value={form.currency}
                    onChange={(e) =>
                      setForm({ ...form, currency: e.target.value.toUpperCase() })
                    }
                  />
                </div>
              </div>
              <div>
                <label className="label">ملاحظة أسفل الإيصال</label>
                <input
                  className="input"
                  value={form.shop.footer_note}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      shop: { ...form.shop, footer_note: e.target.value },
                    })
                  }
                />
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3">
              <h2 className="text-xl font-black mb-1">المستودع الرئيسي</h2>
              <p className="text-sm text-slate-500 mb-4">
                سيُربط كل المنتجات بهذا المستودع. يمكنك إضافة المزيد لاحقاً
                (فروع، مخزن مرتجعات، إلخ).
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">كود المستودع *</label>
                  <input
                    className="input font-mono uppercase"
                    value={form.warehouse.code}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        warehouse: {
                          ...form.warehouse,
                          code: e.target.value.toUpperCase(),
                        },
                      })
                    }
                  />
                </div>
                <div>
                  <label className="label">الاسم *</label>
                  <input
                    className="input"
                    value={form.warehouse.name}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        warehouse: { ...form.warehouse, name: e.target.value },
                      })
                    }
                  />
                </div>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-3">
              <h2 className="text-xl font-black mb-1">إعداد نقاط الولاء</h2>
              <p className="text-sm text-slate-500 mb-4">
                برنامج اختياري يكافئ العملاء على مشترياتهم. يمكنك تعديله
                لاحقاً من الإعدادات.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">نقاط لكل 1 ج.م</label>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    value={form.loyalty?.points_per_egp}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        loyalty: {
                          ...form.loyalty,
                          points_per_egp: parseFloat(e.target.value) || 0,
                        },
                      })
                    }
                  />
                  <div className="text-xs text-slate-500 mt-1">
                    مثال: 0.1 = نقطة لكل 10 ج.م
                  </div>
                </div>
                <div>
                  <label className="label">قيمة النقطة بالجنيه</label>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    value={form.loyalty?.egp_per_point}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        loyalty: {
                          ...form.loyalty,
                          egp_per_point: parseFloat(e.target.value) || 0,
                        },
                      })
                    }
                  />
                  <div className="text-xs text-slate-500 mt-1">
                    مثال: 0.05 = نقطة = 5 قروش
                  </div>
                </div>
                <div>
                  <label className="label">الحد الأدنى للاستبدال</label>
                  <input
                    type="number"
                    className="input"
                    value={form.loyalty?.min_redeem}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        loyalty: {
                          ...form.loyalty,
                          min_redeem: parseInt(e.target.value, 10) || 0,
                        },
                      })
                    }
                  />
                </div>
                <div>
                  <label className="label">أقصى نسبة من الفاتورة (0-1)</label>
                  <input
                    type="number"
                    step="0.1"
                    min={0}
                    max={1}
                    className="input"
                    value={form.loyalty?.max_redeem_ratio}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        loyalty: {
                          ...form.loyalty,
                          max_redeem_ratio: parseFloat(e.target.value) || 0,
                        },
                      })
                    }
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex items-center justify-between">
          <button
            className="btn-ghost"
            onClick={() => setStep((s) => Math.max(0, s - 1) as Step)}
            disabled={step === 0}
          >
            <ChevronRight size={16} /> السابق
          </button>
          {step < 4 ? (
            <button
              className="btn-primary"
              onClick={() => setStep((s) => ((s + 1) as Step))}
              disabled={!canNext()}
            >
              التالي <ChevronLeft size={16} />
            </button>
          ) : (
            <button
              className="btn-primary"
              onClick={() => initM.mutate()}
              disabled={initM.isPending}
            >
              {initM.isPending ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  جارٍ الإعداد...
                </>
              ) : (
                <>
                  <Check size={16} />
                  إنهاء الإعداد
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
