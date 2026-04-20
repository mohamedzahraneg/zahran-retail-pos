import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Search,
  ScanLine,
  PanelLeftClose,
  PanelLeftOpen,
  Trash2,
  Plus,
  Minus,
  UserPlus,
  CreditCard,
  Ticket,
  X,
  Star,
  Briefcase,
  Store,
  Wifi,
  WifiOff,
  Printer,
  Save,
  StickyNote,
  Percent,
  FileText,
  Calendar,
  TrendingUp,
} from 'lucide-react';
import { productsApi, Product, Variant } from '@/api/products.api';
import { categoriesApi } from '@/api/categories.api';
import { stockApi, VariantStockRow } from '@/api/stock.api';
import { posApi } from '@/api/pos.api';
import { couponsApi } from '@/api/coupons.api';
import { loyaltyApi } from '@/api/loyalty.api';
import { customerGroupsApi } from '@/api/customerGroups.api';
import { usersApi } from '@/api/users.api';
import { settingsApi } from '@/api/settings.api';
import { customersApi, Customer } from '@/api/customers.api';
import { shiftsApi } from '@/api/shifts.api';
import { reservationsApi } from '@/api/reservations.api';
import { useCartStore, PaymentDraft, ManualDiscountType } from '@/stores/cart.store';
import { useAuthStore } from '@/stores/auth.store';
import { useLayoutStore } from '@/stores/layout.store';
import { Receipt, ReceiptData } from '@/components/Receipt';

const EGP = (n: number) =>
  `${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;

const WAREHOUSE_ID = import.meta.env.VITE_DEFAULT_WAREHOUSE_ID || '';

export default function POS() {
  const cart = useCartStore();
  const user = useAuthStore((s) => s.user);
  const [category, setCategory] = useState<'all' | 'shoe' | 'bag' | 'accessory'>('all');
  const [stockFilter, setStockFilter] = useState<'all' | 'available' | 'out'>('available');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('');
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [payOpen, setPayOpen] = useState(false);
  const [receiptInvoiceId, setReceiptInvoiceId] = useState<string | null>(null);
  const [customerPickerOpen, setCustomerPickerOpen] = useState(false);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [reserveOpen, setReserveOpen] = useState(false);
  const [itemNotesTarget, setItemNotesTarget] = useState<string | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [now, setNow] = useState(new Date());
  const searchRef = useRef<HTMLInputElement>(null);
  const posProductsOpen = useLayoutStore((s) => s.posProductsOpen);
  const togglePosProducts = useLayoutStore((s) => s.togglePosProducts);
  // Mobile-only view switcher. On desktop both panels are visible side-by-side.
  const [mobileView, setMobileView] = useState<'cart' | 'products'>('cart');

  const { data: shift } = useQuery({
    queryKey: ['current-shift'],
    queryFn: () => shiftsApi.current(),
    refetchInterval: 30_000,
  });

  const { data: products = { data: [], meta: {} as any } } = useQuery({
    queryKey: ['products', category, selectedCategoryId, search, cart.warehouse?.id],
    queryFn: () =>
      productsApi.list({
        type: category === 'all' ? undefined : category,
        q: search || undefined,
        limit: 500,
        warehouse_id: cart.warehouse?.id,
        category_id: selectedCategoryId || undefined,
        active: true,
      }),
    enabled: !!cart.warehouse?.id || true,
  });

  const { data: categoriesList = [] } = useQuery({
    queryKey: ['categories', 'pos'],
    queryFn: () => categoriesApi.list(),
    staleTime: 60_000,
  });

  const filteredProducts = useMemo(() => {
    // When the user is actively searching, show all matches regardless of stock filter.
    if (search.trim()) return products.data;
    if (stockFilter === 'all') return products.data;
    return products.data.filter((p) => {
      const s = p.total_stock ?? 0;
      return stockFilter === 'available' ? s > 0 : s === 0;
    });
  }, [products.data, stockFilter, search]);

  const [variantPickerProduct, setVariantPickerProduct] =
    useState<null | (typeof products.data)[number]>(null);
  const [imageScanOpen, setImageScanOpen] = useState(false);
  const [newCustomerOpen, setNewCustomerOpen] = useState(false);

  // Group-pricing re-price on customer/items change
  useEffect(() => {
    const variantIds = cart.items.map((i) => i.variantId);
    if (variantIds.length === 0) return;
    customerGroupsApi
      .resolve(variantIds, cart.customer?.id)
      .then((prices) => {
        if (prices && Object.keys(prices).length > 0) {
          cart.applyGroupPrices(prices);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.customer?.id, cart.items.length]);

  // Online indicator
  useEffect(() => {
    const goOn = () => setOnline(true);
    const goOff = () => setOnline(false);
    window.addEventListener('online', goOn);
    window.addEventListener('offline', goOff);
    return () => {
      window.removeEventListener('online', goOn);
      window.removeEventListener('offline', goOff);
    };
  }, []);

  // Clock
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Hotkeys: F2 pay, F4 reserve, Ctrl+K search
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'F2') {
        e.preventDefault();
        openPay();
      }
      if (e.key === 'F4') {
        e.preventDefault();
        openReserve();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart.items.length, cart.customer?.id]);

  const createInvoice = useMutation({
    mutationFn: posApi.create,
    onSuccess: (res) => {
      toast.success(`تم إنشاء فاتورة ${res.doc_no} — ${EGP(res.grand_total)}`);
      setReceiptInvoiceId(res.invoice_id);
      setPayOpen(false);
      cart.clear();
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.message || 'فشل إنشاء الفاتورة';
      toast.error(Array.isArray(msg) ? msg[0] : String(msg));
    },
  });

  const scanBarcode = useMutation({
    mutationFn: productsApi.byBarcode,
    onSuccess: ({ product, variant }) => {
      cart.addItem({ product, variant });
    },
    onError: () => toast.error('لم يتم العثور على المنتج'),
  });

  const openPay = () => {
    if (!cart.items.length) {
      toast.error('السلة فارغة');
      return;
    }
    cart.setPayments([{ method: 'cash', amount: cart.grandTotal() }]);
    setPayOpen(true);
  };

  const openReserve = () => {
    if (!cart.items.length) {
      toast.error('السلة فارغة');
      return;
    }
    if (!cart.customer) {
      toast.error('الحجز يتطلب اختيار عميل');
      return;
    }
    setReserveOpen(true);
  };

  const submit = () => {
    if (!cart.items.length) return;
    if (cart.totalPaid() < cart.grandTotal()) {
      toast.error('المبلغ المدفوع أقل من الإجمالي');
      return;
    }
    const warehouseId = cart.warehouse?.id || WAREHOUSE_ID;
    if (!warehouseId) {
      toast.error('يجب اختيار الفرع');
      return;
    }
    createInvoice.mutate({
      warehouse_id: warehouseId,
      customer_id: cart.customer?.id,
      salesperson_id: cart.salesperson?.id,
      lines: cart.items.map((i) => ({
        variant_id: i.variantId,
        qty: i.qty,
        unit_price: i.unitPrice,
        discount: i.discount,
      })),
      payments: cart.payments.map((p) => ({
        payment_method: p.method,
        amount: p.amount,
        reference: p.reference,
      })),
      discount_total: cart.discountTotal(),
      coupon_code: cart.coupon?.code,
      redeem_points: cart.loyalty?.points,
      notes: cart.notes,
    });
  };

  // Draft invoice number preview (actual number is assigned server-side)
  const draftInvoiceNo = useMemo(() => {
    const y = now.getFullYear();
    const d = String(now.getDate()).padStart(2, '0');
    const m = String(now.getMonth() + 1).padStart(2, '0');
    return `INV-${y}${m}${d}-***`;
  }, [now]);

  return (
    <div
      className="flex flex-col overflow-hidden text-slate-100"
      dir="rtl"
      style={{
        // POS is always dark — the workspace is designed for a dark canvas.
        // AppLayout hides the top navbar and inner padding on /pos so this
        // element can fill the viewport exactly.
        height: '100vh',
        width: '100%',
        background:
          'radial-gradient(900px 500px at 90% -10%, rgba(236,72,153,.12), transparent 60%), radial-gradient(900px 500px at -10% 110%, rgba(99,102,241,.12), transparent 60%), linear-gradient(180deg, #0b1020 0%, #0a0f1e 100%)',
      }}
    >
      {/* Compact status strip — logo/title removed to maximise grid area */}
      <div className="px-3 md:px-4 py-1.5 border-b border-white/10 bg-slate-950/40 backdrop-blur flex items-center gap-4 text-xs text-slate-300 flex-wrap">
        <div className="flex items-center gap-1.5">
          <Store size={12} className="text-slate-400" />
          <span className="truncate max-w-[140px]">{cart.warehouse?.name_ar || '—'}</span>
        </div>
        {shift && (
          <div className="hidden sm:block">
            وردية <span className="font-mono text-white">{shift.shift_no}</span>
          </div>
        )}
        <div className="flex items-center gap-1.5 mr-auto">
          <span className="text-rose-300 font-bold">
            {now.toLocaleDateString('ar-EG-u-ca-gregory', { weekday: 'long' })}
          </span>
          <span className="font-mono">{now.toLocaleDateString('en-GB')}</span>
          <span className="font-mono">
            {now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        {user && (
          <div className="hidden md:block">
            <span className="text-white font-bold">{user.full_name}</span>
          </div>
        )}
      </div>

      {/* ─────────── Mobile view switcher (hidden on desktop) ─────────── */}
      <div className="lg:hidden flex gap-2 px-3 py-2 border-b border-white/10 bg-slate-950/40">
        <button
          onClick={() => setMobileView('cart')}
          className={`flex-1 py-2 rounded-lg text-sm font-bold flex items-center justify-center gap-2 ${
            mobileView === 'cart'
              ? 'bg-rose-500 text-white shadow-lg shadow-rose-500/30'
              : 'bg-white/5 text-slate-300 border border-white/10'
          }`}
        >
          🛒 السلة
          {cart.items.length > 0 && (
            <span className="chip bg-white/20 text-white text-[10px]">
              {cart.items.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setMobileView('products')}
          className={`flex-1 py-2 rounded-lg text-sm font-bold ${
            mobileView === 'products'
              ? 'bg-rose-500 text-white shadow-lg shadow-rose-500/30'
              : 'bg-white/5 text-slate-300 border border-white/10'
          }`}
        >
          👠 المنتجات
        </button>
      </div>

      {/* ─────────── Body ─────────── */}
      <div
        className={`flex-1 grid grid-cols-1 min-h-0 ${
          posProductsOpen ? 'lg:grid-cols-[520px_1fr]' : 'lg:grid-cols-[1fr]'
        }`}
      >
        {/* ═══ Cart (right in RTL) ═══
         * When the products panel is hidden on desktop, the cart would stretch
         * to the full window width. Cap it with max-w to keep the UI balanced. */}
        <div
          className={`border-l border-white/10 bg-slate-950/30 flex-col overflow-hidden lg:flex ${
            mobileView === 'cart' ? 'flex' : 'hidden'
          } ${
            !posProductsOpen
              ? 'lg:max-w-[640px] lg:mx-auto lg:w-full lg:border-x lg:border-white/10'
              : ''
          }`}
        >
          {/* Cart header */}
          <div className="p-3 md:p-4 border-b border-white/10 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="font-black text-white text-base md:text-lg flex items-center gap-2">
                فاتورة جديدة
                {cart.items.length > 0 && (
                  <span className="chip bg-rose-500/20 text-rose-300 border border-rose-500/30 text-[11px] font-bold">
                    {cart.items.length} صنف ·{' '}
                    {cart.items.reduce((s, i) => s + i.qty, 0)} قطعة
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-400 font-mono mt-0.5 truncate">
                {draftInvoiceNo}
              </div>
            </div>
            <button
              onClick={cart.clear}
              className="flex items-center gap-1 text-xs text-slate-400 hover:text-rose-400 shrink-0"
              title="مسح الكل"
            >
              <Trash2 size={14} /> مسح
            </button>
          </div>

          {/* Warehouse + Salesperson */}
          <div className="p-3 border-b border-white/10 space-y-2">
            <WarehouseSelect />
            <SalespersonSelect />
          </div>

          {/* Customer */}
          <div className="p-3 border-b border-white/10">
            <div className="flex items-stretch gap-1">
              <button
                onClick={() => setCustomerPickerOpen(true)}
                className="flex-1 flex items-center justify-between gap-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 px-3 py-2 text-right"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <UserPlus size={14} className="text-slate-400 shrink-0" />
                  <div className="min-w-0">
                    <div className="font-bold text-white text-sm truncate">
                      {cart.customer ? cart.customer.full_name : 'عميل نقدي (بدون بيانات)'}
                    </div>
                    {cart.customer && (
                      <div className="text-xs text-slate-400 flex items-center gap-2">
                        <span className="font-mono">{cart.customer.code}</span>
                        {cart.customer.phone && (
                          <span className="font-mono" dir="ltr">
                            {cart.customer.phone}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <span className="text-xs text-brand-300 font-semibold shrink-0">
                  تغيير
                </span>
              </button>
              {cart.customer && (
                <button
                  className="px-2 rounded-lg bg-white/5 hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 border border-white/10"
                  onClick={() => cart.setCustomer(null)}
                  title="إزالة العميل"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            {cart.customer && (
              <div className="grid grid-cols-2 gap-2 mt-2 text-xs">
                <div className="rounded-lg bg-white/5 border border-white/10 p-2">
                  <div className="text-slate-400">الرصيد الحالي</div>
                  <div
                    className={`font-black mt-0.5 ${
                      Number(cart.customer.current_balance || 0) > 0
                        ? 'text-rose-400'
                        : 'text-emerald-400'
                    }`}
                  >
                    {EGP(Number(cart.customer.current_balance || 0))}
                  </div>
                </div>
                <div className="rounded-lg bg-white/5 border border-white/10 p-2">
                  <div className="text-slate-400">المتاح (ائتمان)</div>
                  <div className="font-black text-white mt-0.5">
                    {EGP(
                      Math.max(
                        0,
                        Number(cart.customer.credit_limit || 0) -
                          Number(cart.customer.current_balance || 0),
                      ),
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Items — keeps a minimum visible height so the sold items are always seen */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-[220px]">
            {cart.items.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-center text-slate-400 gap-2 py-10">
                <div className="text-5xl">🛒</div>
                <div className="text-sm">ابحث عن منتج أو امسح الباركود لإضافته</div>
                <div className="text-xs text-slate-500 mt-2 flex gap-4">
                  <kbd className="px-2 py-0.5 rounded bg-white/10 font-mono">Ctrl+K</kbd>
                  للبحث
                  <kbd className="px-2 py-0.5 rounded bg-white/10 font-mono">F2</kbd>
                  للدفع
                  <kbd className="px-2 py-0.5 rounded bg-white/10 font-mono">F4</kbd>
                  لحجز
                </div>
              </div>
            )}
            {cart.items.map((i) => (
              <div
                key={i.variantId}
                className="rounded-xl bg-white/5 border border-white/10 p-3 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-white text-sm truncate">
                      {i.name}
                    </div>
                    <div className="text-xs text-slate-400 flex items-center flex-wrap gap-x-2 gap-y-0.5 mt-0.5">
                      <span className="font-mono">{i.productCode}</span>
                      {i.color && (
                        <span className="text-pink-300">• {i.color}</span>
                      )}
                      {i.size && (
                        <span className="text-cyan-300">• مقاس {i.size}</span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 font-mono mt-0.5">
                      SKU: {i.sku}
                    </div>
                  </div>
                  <button
                    onClick={() => cart.removeItem(i.variantId)}
                    className="p-1 rounded hover:bg-rose-500/20 text-rose-400"
                    title="حذف"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1">
                    <button
                      className="w-7 h-7 rounded bg-white/10 hover:bg-white/20 flex items-center justify-center"
                      onClick={() => cart.updateQty(i.variantId, i.qty - 1)}
                    >
                      <Minus size={14} />
                    </button>
                    <span className="w-9 text-center font-black text-white">
                      {i.qty}
                    </span>
                    <button
                      className="w-7 h-7 rounded bg-white/10 hover:bg-white/20 flex items-center justify-center"
                      onClick={() => cart.updateQty(i.variantId, i.qty + 1)}
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  <div className="text-left">
                    <div className="text-xs text-slate-400">
                      {EGP(i.unitPrice)}
                    </div>
                    <div className="font-black text-rose-400">
                      {EGP(i.qty * i.unitPrice - (i.discount || 0))}
                    </div>
                  </div>
                </div>

                <button
                  className="w-full text-xs flex items-center justify-center gap-1 py-1 rounded border border-dashed border-white/10 hover:bg-white/5 text-slate-400 hover:text-slate-200"
                  onClick={() => setItemNotesTarget(i.variantId)}
                >
                  <StickyNote size={12} />
                  {i.notes ? `ملاحظة: ${i.notes}` : 'إضافة ملاحظة'}
                </button>
              </div>
            ))}
          </div>

          {/* Coupon + Loyalty */}
          <CouponBox />
          <LoyaltyBox />

          {/* Totals */}
          <div className="p-4 bg-slate-950/50 border-t border-white/10 space-y-1 text-sm">
            <TotalRow label="الإجمالي قبل الخصم" value={cart.subtotal()} />
            {cart.manualDiscountAmount() > 0 && (
              <TotalRow
                label={`الخصم ${
                  cart.manualDiscountType === 'percent'
                    ? `(${cart.manualDiscountInput}%)`
                    : '(قيمة)'
                }`}
                value={-cart.manualDiscountAmount()}
                color="text-amber-400"
              />
            )}
            {cart.coupon && (
              <TotalRow
                label={`كوبون (${cart.coupon.code})`}
                value={-Number(cart.coupon.discount_amount)}
                color="text-emerald-400"
              />
            )}
            {cart.loyalty && (
              <TotalRow
                label={`نقاط ولاء (${cart.loyalty.points})`}
                value={-Number(cart.loyalty.egp_discount)}
                color="text-amber-300"
              />
            )}
            <TotalRow label="الضريبة" value={0} />

            <div className="flex items-center justify-between pt-2 border-t border-white/10">
              <div>
                <div className="text-xs text-slate-400">الإجمالي</div>
                <div className="text-2xl font-black text-emerald-400">
                  {EGP(cart.grandTotal())}
                </div>
              </div>
              <div className="text-left">
                <div className="text-xs text-slate-400 flex items-center gap-1 justify-end">
                  <TrendingUp size={12} /> ربح الفاتورة
                </div>
                <div
                  className={`text-sm font-black ${
                    cart.profit() >= 0 ? 'text-emerald-300' : 'text-rose-400'
                  }`}
                >
                  {EGP(cart.profit())}
                </div>
              </div>
            </div>
          </div>

          {/* Action buttons row 1: discount / coupon / note */}
          <div className="px-3 py-2 grid grid-cols-3 gap-2 border-t border-white/10">
            <button
              className={`py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-1 border ${
                cart.manualDiscountAmount() > 0
                  ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                  : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'
              }`}
              onClick={() => setDiscountOpen(true)}
            >
              <Percent size={14} /> خصم
            </button>
            <button
              className={`py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-1 border ${
                cart.coupon
                  ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
                  : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'
              }`}
              onClick={() => {
                const code = prompt('أدخل كود الكوبون:');
                if (code) {
                  couponsApi
                    .validate({
                      code: code.trim(),
                      customer_id: cart.customer?.id,
                      subtotal: cart.subtotal(),
                    })
                    .then((res) => {
                      cart.setCoupon({
                        coupon_id: res.coupon_id,
                        code: res.code,
                        name_ar: res.name_ar,
                        discount_amount: res.discount_amount,
                      });
                      toast.success(
                        `تم تطبيق الكوبون: خصم ${EGP(res.discount_amount)}`,
                      );
                    })
                    .catch((e) =>
                      toast.error(
                        e?.response?.data?.message || 'كوبون غير صالح',
                      ),
                    );
                }
              }}
            >
              <Ticket size={14} /> كوبون
            </button>
            <button
              className={`py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-1 border ${
                cart.notes
                  ? 'bg-brand-500/20 border-brand-500/40 text-brand-200'
                  : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'
              }`}
              onClick={() => {
                const n = prompt('ملاحظة الفاتورة:', cart.notes || '');
                if (n !== null) cart.setNotes(n);
              }}
            >
              <StickyNote size={14} /> تعليق
            </button>
          </div>

          {/* Main action buttons: F2 pay / F4 reserve */}
          <div className="p-3 pt-0 grid grid-cols-2 gap-2">
            <button
              className="py-3 rounded-xl font-black text-white bg-gradient-to-br from-orange-500 to-amber-600 shadow-lg shadow-amber-500/30 hover:shadow-amber-500/50 transition disabled:opacity-40"
              onClick={openReserve}
              disabled={cart.items.length === 0}
            >
              <span className="flex items-center justify-center gap-2">
                <Calendar size={18} />
                حجز بعربون <span className="text-xs opacity-80">F4</span>
              </span>
            </button>
            <button
              className="py-3 rounded-xl font-black text-white bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/30 hover:shadow-emerald-500/50 transition disabled:opacity-40"
              onClick={openPay}
              disabled={cart.items.length === 0}
            >
              <span className="flex items-center justify-center gap-2">
                <CreditCard size={18} />
                دفع وطباعة <span className="text-xs opacity-80">F2</span>
              </span>
            </button>
          </div>
        </div>

        {/* ═══ Products grid (left in RTL) — mobile: shown only when mobileView='products' ═══ */}
        <div
          className={`flex-col overflow-hidden p-3 md:p-4 gap-3 lg:flex ${
            mobileView === 'products' ? 'flex' : 'hidden'
          }`}
        >
          {/* Search bar — always visible */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search
                size={16}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
              />
              <input
                ref={searchRef}
                className="w-full bg-white/5 border border-rose-500/30 rounded-xl px-10 py-3 text-white placeholder:text-slate-500 focus:border-rose-500/60 focus:outline-none"
                placeholder="ابحث بالاسم أو امسح الباركود..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <kbd className="absolute left-3 top-1/2 -translate-y-1/2 text-xs bg-white/10 px-2 py-0.5 rounded font-mono text-slate-400 hidden md:block">
                Ctrl+K
              </kbd>
            </div>
            <button
              className="p-3 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-slate-300"
              onClick={() => setImageScanOpen(true)}
              title="بحث بصورة أو مسح باركود بالكاميرا"
            >
              <ScanLine size={18} />
            </button>
            <button
              className="p-3 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-slate-300"
              onClick={() => {
                const code = prompt('أدخل الباركود:');
                if (code) scanBarcode.mutate(code);
              }}
              title="إدخال باركود يدوياً"
            >
              <FileText size={18} />
            </button>
            <button
              className={`hidden lg:block p-3 rounded-xl border transition ${
                posProductsOpen
                  ? 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'
                  : 'bg-rose-500/20 border-rose-500/40 text-rose-200'
              }`}
              onClick={togglePosProducts}
              title={posProductsOpen ? 'إخفاء شبكة المنتجات' : 'إظهار شبكة المنتجات'}
            >
              {posProductsOpen ? (
                <PanelLeftClose size={18} />
              ) : (
                <PanelLeftOpen size={18} />
              )}
            </button>
          </div>

          {/* Filters — only stock availability is visible by default; the rest (type + category groups) are hidden behind a toggle */}
          {posProductsOpen && (
          <div className="space-y-2">
            {/* Stock availability filter (always visible) + toggle */}
            <div className="flex items-center justify-end gap-2 flex-wrap">
              {(
                [
                  { k: 'available', label: '✔ المتاح' },
                  { k: 'out', label: '✖ النافذ' },
                ] as const
              ).map((s) => (
                <button
                  key={s.k}
                  onClick={() => setStockFilter(s.k as any)}
                  className={`px-3 py-1 rounded-full text-xs font-bold transition ${
                    stockFilter === s.k
                      ? 'bg-emerald-500/90 text-white shadow shadow-emerald-500/30'
                      : 'bg-white/5 text-slate-300 border border-white/10 hover:bg-white/10'
                  }`}
                >
                  {s.label}
                </button>
              ))}
              <button
                onClick={() => setMoreFiltersOpen((v) => !v)}
                className="px-3 py-1 rounded-full text-xs font-bold bg-white/5 text-slate-300 border border-white/10 hover:bg-white/10"
              >
                {moreFiltersOpen ? '▲ إخفاء الفلاتر' : '▼ فلاتر متقدمة'}
              </button>
            </div>

            {/* Hidden filters: type tabs + category groups */}
            {moreFiltersOpen && (
              <>
                <div className="flex items-center justify-end gap-2 flex-wrap">
                  {(['all', 'shoe', 'bag', 'accessory'] as const).map((c) => {
                    const labels: Record<string, string> = {
                      all: 'الكل',
                      shoe: '👠 أحذية',
                      bag: '👜 حقائب',
                      accessory: '💍 إكسسوارات',
                    };
                    return (
                      <button
                        key={c}
                        onClick={() => setCategory(c)}
                        className={`px-4 py-1.5 rounded-full text-sm font-bold transition ${
                          category === c
                            ? 'bg-rose-500 text-white shadow-lg shadow-rose-500/30'
                            : 'bg-white/5 text-slate-300 border border-white/10 hover:bg-white/10'
                        }`}
                      >
                        {labels[c]}
                      </button>
                    );
                  })}
                  <button
                    onClick={() => setStockFilter('all')}
                    className={`px-3 py-1 rounded-full text-xs font-bold transition ${
                      stockFilter === 'all'
                        ? 'bg-emerald-500/90 text-white'
                        : 'bg-white/5 text-slate-300 border border-white/10 hover:bg-white/10'
                    }`}
                  >
                    كل الحالات
                  </button>
                </div>

                {categoriesList.length > 0 && (
                  <div className="flex items-center justify-end gap-2 flex-wrap">
                    <button
                      onClick={() => setSelectedCategoryId('')}
                      className={`px-3 py-1 rounded-full text-xs font-bold transition ${
                        selectedCategoryId === ''
                          ? 'bg-indigo-500 text-white shadow shadow-indigo-500/30'
                          : 'bg-white/5 text-slate-300 border border-white/10 hover:bg-white/10'
                      }`}
                    >
                      كل المجموعات
                    </button>
                    {categoriesList
                      .filter((c) => c.is_active !== false)
                      .map((c) => (
                        <button
                          key={c.id}
                          onClick={() => setSelectedCategoryId(c.id)}
                          className={`px-3 py-1 rounded-full text-xs font-bold transition ${
                            selectedCategoryId === c.id
                              ? 'bg-indigo-500 text-white shadow shadow-indigo-500/30'
                              : 'bg-white/5 text-slate-300 border border-white/10 hover:bg-white/10'
                          }`}
                          title={c.name_ar}
                        >
                          {c.icon ? `${c.icon} ` : ''}
                          {c.name_ar}
                          {typeof c.products_count === 'number' ? (
                            <span className="mr-1 text-[10px] opacity-70">
                              ({c.products_count})
                            </span>
                          ) : null}
                        </button>
                      ))}
                  </div>
                )}
              </>
            )}
          </div>
          )}

          {/* Products grid — hidden when panel is collapsed; search box stays */}
          {posProductsOpen && (
          <div className="flex-1 overflow-y-auto">
            {filteredProducts.length === 0 && (
              <div className="text-center py-8 text-slate-400 text-sm">
                لا توجد منتجات تطابق الفلتر الحالي
              </div>
            )}
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
              {filteredProducts.map((p) => {
                const stock = p.total_stock ?? 0;
                const outOfStock = stock === 0;
                return (
                  <button
                    key={p.id}
                    onClick={() => {
                      if (outOfStock) {
                        toast.error('المنتج نافذ — لا يمكن إضافته للفاتورة');
                        return;
                      }
                      setVariantPickerProduct(p);
                    }}
                    className={`text-right rounded-xl border p-4 transition ${
                      outOfStock
                        ? 'bg-white/[0.02] border-white/5 opacity-60 cursor-not-allowed'
                        : 'bg-white/5 border-white/10 hover:bg-white/10 hover:border-pink-500/40 hover:-translate-y-0.5'
                    }`}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="text-4xl">
                        {/* Name-based icon: anything that mentions a bag gets a handbag, everything else gets a shoe */}
                        {/(^|\s)(شنط|شنطة|حقيبة|حقائب|كلاتش|ظهر)/i.test(p.name_ar || '') ? '👜' : '👠'}
                      </div>
                      {outOfStock ? (
                        <span className="chip bg-rose-500/20 text-rose-300 border border-rose-500/30 text-[10px] font-black">
                          نفذ
                        </span>
                      ) : (
                        <span
                          className={`chip border text-[10px] font-bold ${
                            stock <= 2
                              ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                              : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                          }`}
                        >
                          {stock} متوفر
                        </span>
                      )}
                    </div>
                    <div className="font-bold text-white text-sm mb-1 truncate">
                      {p.name_ar}
                    </div>
                    <div className="text-xs text-slate-400 mb-2 flex items-center justify-between">
                      <span className="font-mono">{p.sku_root}</span>
                      {p.variants_count ? (
                        <span className="text-slate-500">
                          {p.variants_count} أصناف
                        </span>
                      ) : null}
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="font-black text-rose-400">
                        {EGP(Number(p.base_price))}
                      </div>
                      {!p.is_active && (
                        <span className="text-xs text-rose-400 font-bold">
                          متوقف
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
          )}

          {/* Products footer — also hidden when panel collapsed */}
          {posProductsOpen && (
          <div className="mt-2 px-4 py-2 rounded-xl bg-white/5 border border-white/10 flex items-center justify-between text-xs text-slate-300 flex-wrap gap-2">
            <div className="flex items-center gap-4 flex-wrap">
              <span>
                المعروض:{' '}
                <b className="text-white">{filteredProducts.length}</b>
                {filteredProducts.length !== products.data.length && (
                  <span className="text-slate-500"> / {products.data.length}</span>
                )}
              </span>
              <span>
                الأصناف المتاحة:{' '}
                <b className="text-emerald-300">
                  {filteredProducts.reduce(
                    (s, p) => s + (Number(p.variants_count) || 0),
                    0,
                  )}
                </b>
              </span>
              <span>
                إجمالي الكميات:{' '}
                <b className="text-white">
                  {filteredProducts.reduce(
                    (s, p) => s + (Number(p.total_stock) || 0),
                    0,
                  )}
                </b>
              </span>
            </div>
            <div className="text-slate-400">
              {cart.warehouse?.name_ar || '—'}
            </div>
          </div>
          )}

          {/* Hint shown when panel is collapsed — only search remains */}
          {!posProductsOpen && (
            <div className="flex-1 flex items-center justify-center text-center text-slate-500 text-sm px-6">
              <div>
                شبكة المنتجات مخفية. استخدم شريط البحث أو الباركود لإضافة منتج.
                <br />
                <button
                  onClick={togglePosProducts}
                  className="mt-3 px-4 py-2 rounded-lg bg-rose-500/20 border border-rose-500/40 text-rose-200 text-xs font-bold hover:bg-rose-500/30"
                >
                  إظهار شبكة المنتجات
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ─────────── Modals ─────────── */}
      {payOpen && (
        <PaymentModal
          onClose={() => setPayOpen(false)}
          onConfirm={submit}
          isPending={createInvoice.isPending}
        />
      )}
      {receiptInvoiceId && (
        <ReceiptModal
          invoiceId={receiptInvoiceId}
          onClose={() => setReceiptInvoiceId(null)}
        />
      )}
      {customerPickerOpen && (
        <CustomerPickerModal
          onClose={() => setCustomerPickerOpen(false)}
          onPick={(c) => {
            cart.setCustomer(c);
            setCustomerPickerOpen(false);
          }}
          onCreateNew={() => {
            setCustomerPickerOpen(false);
            setNewCustomerOpen(true);
          }}
        />
      )}
      {newCustomerOpen && (
        <NewCustomerModal
          onClose={() => setNewCustomerOpen(false)}
          onCreated={(c) => {
            cart.setCustomer(c);
            setNewCustomerOpen(false);
            toast.success('تم إضافة العميل وتحديده للفاتورة');
          }}
        />
      )}
      {variantPickerProduct && (
        <VariantPickerModal
          product={variantPickerProduct}
          warehouseId={cart.warehouse?.id}
          onClose={() => setVariantPickerProduct(null)}
          onPick={(product, variant) => {
            cart.addItem({ product, variant });
            setVariantPickerProduct(null);
          }}
        />
      )}
      {imageScanOpen && (
        <ImageScanModal
          onClose={() => setImageScanOpen(false)}
          onBarcode={(code) => {
            setImageScanOpen(false);
            scanBarcode.mutate(code);
          }}
        />
      )}
      {discountOpen && (
        <DiscountModal onClose={() => setDiscountOpen(false)} />
      )}
      {reserveOpen && (
        <ReserveModal
          onClose={() => setReserveOpen(false)}
          onSuccess={() => {
            setReserveOpen(false);
            cart.clear();
          }}
        />
      )}
      {itemNotesTarget && (
        <ItemNotesModal
          variantId={itemNotesTarget}
          onClose={() => setItemNotesTarget(null)}
        />
      )}
    </div>
  );
}

/* ─────────────────── subcomponents ─────────────────── */

function TotalRow({
  label,
  value,
  color = 'text-slate-200',
}: {
  label: string;
  value: number;
  color?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-400">{label}</span>
      <span className={`font-bold ${color}`}>{EGP(value)}</span>
    </div>
  );
}

function WarehouseSelect() {
  const cart = useCartStore();
  const { data: warehouses = [] } = useQuery({
    queryKey: ['warehouses-active'],
    queryFn: () => settingsApi.listWarehouses(false),
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (!cart.warehouse && warehouses.length) {
      const main = warehouses.find((w) => w.is_main) || warehouses[0];
      cart.setWarehouse({
        id: main.id,
        code: main.code,
        name_ar: main.name_ar,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warehouses.length]);

  return (
    <div className="flex items-center gap-2">
      <Store size={14} className="text-slate-400 shrink-0" />
      <select
        className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-sm text-white"
        value={cart.warehouse?.id ?? ''}
        onChange={(e) => {
          const id = e.target.value;
          const w = warehouses.find((x) => x.id === id);
          if (w) {
            cart.setWarehouse({
              id: w.id,
              code: w.code,
              name_ar: w.name_ar,
            });
          }
        }}
      >
        {warehouses.length === 0 && (
          <option value="">— تحميل الفروع —</option>
        )}
        {warehouses.map((w) => (
          <option key={w.id} value={w.id} className="bg-slate-900">
            {w.name_ar} {w.is_main ? '★' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

function SalespersonSelect() {
  const cart = useCartStore();
  const { data: users = [] } = useQuery({
    queryKey: ['users-active'],
    queryFn: () => usersApi.list(),
    staleTime: 5 * 60 * 1000,
  });
  const salespeople = (users || []).filter((u) => u.is_active);

  return (
    <div className="flex items-center gap-2">
      <Briefcase size={14} className="text-slate-400 shrink-0" />
      <select
        className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-sm text-white"
        value={cart.salesperson?.id ?? ''}
        onChange={(e) => {
          const id = e.target.value;
          if (!id) {
            cart.setSalesperson(null);
            return;
          }
          const u = salespeople.find((x) => x.id === id);
          if (u) {
            cart.setSalesperson({
              id: u.id,
              full_name: u.full_name || u.username,
            });
          }
        }}
      >
        <option value="" className="bg-slate-900">
          — اختر البائع —
        </option>
        {salespeople.map((u) => (
          <option key={u.id} value={u.id} className="bg-slate-900">
            {u.full_name || u.username}
          </option>
        ))}
      </select>
      {cart.salesperson && (
        <button
          onClick={() => cart.setSalesperson(null)}
          className="p-1 rounded hover:bg-rose-500/20 text-slate-400"
          title="إزالة البائع"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

function CouponBox() {
  const cart = useCartStore();
  if (!cart.coupon) return null;
  return (
    <div className="px-4 py-2 bg-emerald-500/10 border-t border-emerald-500/30 flex items-center justify-between">
      <div className="flex items-center gap-2 text-sm">
        <Ticket size={16} className="text-emerald-400" />
        <span className="font-bold text-emerald-300">{cart.coupon.code}</span>
        <span className="text-emerald-400 text-xs">— {cart.coupon.name_ar}</span>
      </div>
      <button
        className="text-rose-400 hover:bg-rose-500/20 p-1 rounded"
        onClick={() => cart.setCoupon(null)}
        title="إزالة الكوبون"
      >
        <X size={14} />
      </button>
    </div>
  );
}

function LoyaltyBox() {
  const cart = useCartStore();
  const [points, setPoints] = useState('');
  const { data: balance } = useQuery({
    queryKey: ['loyalty-customer', cart.customer?.id],
    queryFn: () => loyaltyApi.customer(cart.customer!.id),
    enabled: !!cart.customer?.id,
  });
  const applyM = useMutation({
    mutationFn: () =>
      loyaltyApi.preview(
        cart.customer!.id,
        parseInt(points, 10),
        cart.subtotal(),
      ),
    onSuccess: (res) => {
      cart.setLoyalty({
        points: res.applied_points,
        egp_discount: res.applied_egp,
      });
      toast.success(`خصم ${EGP(res.applied_egp)} مقابل ${res.applied_points} نقطة`);
      setPoints('');
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'لا يمكن استبدال النقاط'),
  });

  if (!cart.customer?.id) return null;
  if (cart.items.length === 0) return null;
  if (cart.loyalty) {
    return (
      <div className="px-4 py-2 bg-amber-500/10 border-t border-amber-500/30 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <Star size={16} className="text-amber-400" />
          <span className="font-bold text-amber-300">
            {cart.loyalty.points} نقطة
          </span>
          <span className="text-amber-400 text-xs">
            — خصم {EGP(Number(cart.loyalty.egp_discount))}
          </span>
        </div>
        <button
          className="text-rose-400 hover:bg-rose-500/20 p-1 rounded"
          onClick={() => cart.setLoyalty(null)}
          title="إلغاء"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  const available = balance?.loyalty_points ?? 0;
  const minRedeem = balance?.config?.min_redeem ?? 100;
  if (available < minRedeem) return null;

  return (
    <div className="px-4 py-2 border-t border-white/10 flex items-center gap-2 text-xs">
      <Star size={14} className="text-amber-400 shrink-0" />
      <span className="text-slate-400">
        {available.toLocaleString()} نقطة متاحة
      </span>
      <input
        type="number"
        min={minRedeem}
        className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-white"
        placeholder={`نقاط (حد أدنى ${minRedeem})`}
        value={points}
        onChange={(e) => setPoints(e.target.value)}
      />
      <button
        className="px-3 py-1 rounded bg-amber-500/20 text-amber-300 font-bold disabled:opacity-40"
        onClick={() => points && applyM.mutate()}
        disabled={applyM.isPending || !points}
      >
        استبدال
      </button>
    </div>
  );
}

function CustomerPickerModal({
  onClose,
  onPick,
  onCreateNew,
}: {
  onClose: () => void;
  onPick: (c: Customer) => void;
  onCreateNew: () => void;
}) {
  const [q, setQ] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['pos-customer-picker', q],
    queryFn: () => customersApi.list({ q: q || undefined, limit: 50 }),
  });
  const customers = data?.data || [];

  return (
    <ModalShell onClose={onClose} title="اختر العميل">
      <div className="p-4 border-b border-white/10 space-y-2">
        <div className="relative">
          <Search
            size={16}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            autoFocus
            className="w-full bg-white/5 border border-white/10 rounded-lg px-10 py-2 text-white"
            placeholder="ابحث بالاسم أو الكود أو الهاتف..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <button
          className="w-full py-2 rounded-lg bg-gradient-to-br from-brand-500 to-pink-600 text-white font-bold text-sm flex items-center justify-center gap-2"
          onClick={onCreateNew}
        >
          <UserPlus size={16} /> + إضافة عميل جديد
        </button>
      </div>
      <div className="max-h-80 overflow-y-auto">
        {isLoading && (
          <div className="p-6 text-center text-slate-400 text-sm">جارٍ التحميل...</div>
        )}
        {!isLoading && customers.length === 0 && (
          <div className="p-6 text-center text-slate-400 text-sm">لا توجد نتائج</div>
        )}
        {customers.map((c) => (
          <button
            key={c.id}
            className="w-full p-3 flex items-center justify-between border-b border-white/5 hover:bg-white/5 text-right"
            onClick={() => onPick(c)}
          >
            <div className="min-w-0">
              <div className="font-bold text-white truncate">{c.full_name}</div>
              <div className="text-xs text-slate-400 font-mono">{c.code}</div>
            </div>
            <div className="text-xs text-slate-400 space-y-0.5 text-left">
              {c.phone && (
                <div className="font-mono" dir="ltr">
                  {c.phone}
                </div>
              )}
              <div>
                الرصيد:{' '}
                <span
                  className={
                    Number(c.current_balance || 0) > 0
                      ? 'text-rose-400'
                      : 'text-emerald-400'
                  }
                >
                  {EGP(Number(c.current_balance || 0))}
                </span>
              </div>
            </div>
          </button>
        ))}
      </div>
    </ModalShell>
  );
}

function DiscountModal({ onClose }: { onClose: () => void }) {
  const cart = useCartStore();
  const [type, setType] = useState<ManualDiscountType>(cart.manualDiscountType);
  const [value, setValue] = useState(String(cart.manualDiscountInput || ''));

  const apply = () => {
    const v = Number(value);
    if (isNaN(v) || v < 0) {
      toast.error('أدخل قيمة صحيحة');
      return;
    }
    if (type === 'percent' && v > 100) {
      toast.error('النسبة لا يمكن أن تزيد عن 100%');
      return;
    }
    cart.setManualDiscount(type, v);
    onClose();
  };

  return (
    <ModalShell onClose={onClose} title="خصم الفاتورة">
      <div className="p-5 space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setType('percent')}
            className={`py-3 rounded-lg font-bold border ${
              type === 'percent'
                ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                : 'bg-white/5 border-white/10 text-slate-300'
            }`}
          >
            <Percent size={16} className="inline ml-1" /> نسبة %
          </button>
          <button
            onClick={() => setType('value')}
            className={`py-3 rounded-lg font-bold border ${
              type === 'value'
                ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                : 'bg-white/5 border-white/10 text-slate-300'
            }`}
          >
            قيمة ثابتة (ج.م)
          </button>
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">
            {type === 'percent' ? 'نسبة الخصم (%)' : 'قيمة الخصم (ج.م)'}
          </label>
          <input
            autoFocus
            type="number"
            step="0.01"
            min={0}
            max={type === 'percent' ? 100 : undefined}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-lg font-bold"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
          />
        </div>
        <div className="text-sm text-slate-400 flex justify-between bg-white/5 rounded-lg p-3">
          <span>الإجمالي قبل الخصم</span>
          <span className="font-bold text-white">{EGP(cart.subtotal())}</span>
        </div>
        <div className="flex gap-2">
          <button
            className="flex-1 py-2.5 rounded-lg bg-amber-500 text-white font-bold hover:bg-amber-600"
            onClick={apply}
          >
            تطبيق الخصم
          </button>
          {cart.manualDiscountInput > 0 && (
            <button
              className="px-4 py-2.5 rounded-lg bg-white/5 text-slate-300 hover:bg-rose-500/20 hover:text-rose-300"
              onClick={() => {
                cart.clearManualDiscount();
                onClose();
              }}
            >
              إزالة
            </button>
          )}
          <button
            className="px-4 py-2.5 rounded-lg bg-white/5 text-slate-300 hover:bg-white/10"
            onClick={onClose}
          >
            إلغاء
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function ReserveModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const cart = useCartStore();
  const qc = useQueryClient();
  const [deposit, setDeposit] = useState(
    String(Math.round(cart.grandTotal() * 0.3)),
  );
  const [method, setMethod] = useState<PaymentDraft['method']>('cash');
  const [expires, setExpires] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return d.toISOString().slice(0, 10);
  });
  const [notes, setNotes] = useState(cart.notes || '');
  const [createdReceipt, setCreatedReceipt] = useState<null | {
    reservation_no: string;
    total_amount: number;
    paid_amount: number;
    remaining_amount: number;
    expires_at: string;
  }>(null);

  const mutation = useMutation({
    mutationFn: () => {
      if (!cart.customer) throw new Error('missing customer');
      if (!cart.warehouse) throw new Error('missing warehouse');
      return reservationsApi.create({
        customer_id: cart.customer.id,
        warehouse_id: cart.warehouse.id,
        items: cart.items.map((i) => ({
          variant_id: i.variantId,
          quantity: i.qty,
          unit_price: i.unitPrice,
          discount_amount: i.discount || 0,
          notes: i.notes || undefined,
        })),
        payments: [
          {
            payment_method: method,
            amount: Number(deposit),
            kind: 'deposit',
          },
        ],
        discount_amount: cart.discountTotal(),
        expires_at: expires,
        notes: notes || undefined,
      });
    },
    onSuccess: (res) => {
      toast.success(`تم الحجز ${res.reservation_no}`);
      qc.invalidateQueries({ queryKey: ['reservations'] });
      setCreatedReceipt({
        reservation_no: res.reservation_no,
        total_amount: Number(res.total_amount ?? cart.grandTotal()),
        paid_amount: Number(res.paid_amount ?? deposit),
        remaining_amount: Number(
          res.remaining_amount ?? cart.grandTotal() - Number(deposit),
        ),
        expires_at: expires,
      });
    },
    onError: (e: any) => {
      toast.error(e?.response?.data?.message || 'فشل إنشاء الحجز');
    },
  });

  if (createdReceipt) {
    return (
      <ReservationReceiptModal
        data={createdReceipt}
        items={cart.items.map((i) => ({
          name: i.name,
          sku: i.sku,
          color: i.color,
          size: i.size,
          qty: i.qty,
          unitPrice: i.unitPrice,
          total: i.qty * i.unitPrice - (i.discount || 0),
        }))}
        customer={cart.customer}
        warehouse={cart.warehouse}
        method={method}
        notes={notes}
        onClose={() => {
          setCreatedReceipt(null);
          onSuccess();
        }}
      />
    );
  }

  return (
    <ModalShell onClose={onClose} title="حجز بعربون">
      <div className="p-5 space-y-4">
        <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-sm text-amber-200">
          <Calendar size={18} className="shrink-0 mt-0.5" />
          <div>
            <div className="font-bold mb-0.5">
              حجز للعميل: {cart.customer?.full_name}
            </div>
            <div className="text-xs text-amber-300/80">
              الإجمالي {EGP(cart.grandTotal())} · {cart.items.length} صنف
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-slate-400 block mb-1">
              العربون (ج.م) *
            </label>
            <input
              type="number"
              step="0.01"
              min={0}
              max={cart.grandTotal()}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white"
              value={deposit}
              onChange={(e) => setDeposit(e.target.value)}
            />
            <div className="text-xs text-slate-400 mt-1">
              المتبقي:{' '}
              <span className="text-amber-300">
                {EGP(Math.max(0, cart.grandTotal() - Number(deposit || 0)))}
              </span>
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">طريقة الدفع</label>
            <select
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white"
              value={method}
              onChange={(e) => setMethod(e.target.value as any)}
            >
              <option value="cash" className="bg-slate-900">
                💵 كاش
              </option>
              <option value="card" className="bg-slate-900">
                💳 كارت
              </option>
              <option value="instapay" className="bg-slate-900">
                📱 إنستا باي
              </option>
              <option value="bank_transfer" className="bg-slate-900">
                🏦 تحويل بنكي
              </option>
            </select>
          </div>
        </div>

        <div>
          <label className="text-xs text-slate-400 block mb-1">
            تاريخ انتهاء الحجز
          </label>
          <input
            type="date"
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white"
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
          />
        </div>

        <div>
          <label className="text-xs text-slate-400 block mb-1">
            ملاحظات الحجز
          </label>
          <textarea
            rows={3}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="أي ملاحظات للحجز..."
          />
        </div>

        <div className="flex gap-2 pt-2">
          <button
            className="flex-1 py-2.5 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 text-white font-bold hover:opacity-90 disabled:opacity-40"
            onClick={() => {
              const d = Number(deposit);
              if (!d || d <= 0) {
                toast.error('العربون مطلوب');
                return;
              }
              mutation.mutate();
            }}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? 'جاري الحفظ...' : 'تأكيد الحجز'}
          </button>
          <button
            className="px-4 py-2.5 rounded-lg bg-white/5 text-slate-300 hover:bg-white/10"
            onClick={onClose}
          >
            إلغاء
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function ItemNotesModal({
  variantId,
  onClose,
}: {
  variantId: string;
  onClose: () => void;
}) {
  const cart = useCartStore();
  const item = cart.items.find((i) => i.variantId === variantId);
  const [notes, setNotes] = useState(item?.notes || '');
  if (!item) return null;

  return (
    <ModalShell onClose={onClose} title={`ملاحظة: ${item.name}`}>
      <div className="p-5 space-y-3">
        <textarea
          autoFocus
          rows={4}
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="ملاحظة خاصة بهذا الصنف..."
        />
        <div className="flex gap-2">
          <button
            className="flex-1 py-2.5 rounded-lg bg-brand-500 text-white font-bold hover:bg-brand-600"
            onClick={() => {
              cart.setItemNotes(variantId, notes);
              onClose();
            }}
          >
            حفظ
          </button>
          <button
            className="px-4 py-2.5 rounded-lg bg-white/5 text-slate-300 hover:bg-white/10"
            onClick={onClose}
          >
            إلغاء
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function PaymentModal({
  onClose,
  onConfirm,
  isPending,
}: {
  onClose: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  const cart = useCartStore();
  const [method, setMethod] = useState<PaymentDraft['method']>('cash');
  const [amount, setAmount] = useState(cart.grandTotal());
  const change = Math.max(0, amount - cart.grandTotal());

  return (
    <ModalShell onClose={onClose} title="إتمام الدفع">
      <div className="p-5 space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {(['cash', 'card', 'instapay', 'bank_transfer'] as const).map((m) => {
            const labels: Record<string, string> = {
              cash: '💵 كاش',
              card: '💳 كارت',
              instapay: '📱 إنستاباي',
              bank_transfer: '🏦 تحويل',
            };
            return (
              <button
                key={m}
                onClick={() => setMethod(m)}
                className={`p-3 rounded-lg font-bold border ${
                  method === m
                    ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                    : 'bg-white/5 border-white/10 text-slate-300'
                }`}
              >
                {labels[m]}
              </button>
            );
          })}
        </div>

        <div>
          <label className="text-xs text-slate-400 block mb-1">
            الإجمالي المطلوب
          </label>
          <div className="text-3xl font-black text-emerald-400 text-center py-2 bg-white/5 rounded-lg">
            {EGP(cart.grandTotal())}
          </div>
        </div>

        <div>
          <label className="text-xs text-slate-400 block mb-1">
            المبلغ المستلم
          </label>
          <input
            autoFocus
            type="number"
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-3 text-white text-xl font-bold"
            value={amount}
            onChange={(e) => setAmount(parseFloat(e.target.value) || 0)}
          />
        </div>

        <div className="flex justify-between p-3 bg-white/5 rounded-lg">
          <span className="text-slate-400">الباقي للعميل</span>
          <span className="font-black text-emerald-400">{EGP(change)}</span>
        </div>

        <div className="flex gap-2">
          <button
            className="flex-1 py-2.5 rounded-lg bg-white/5 text-slate-300 hover:bg-white/10"
            onClick={onClose}
          >
            إلغاء
          </button>
          <button
            className="flex-1 py-2.5 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 text-white font-bold hover:opacity-90 disabled:opacity-40"
            onClick={() => {
              cart.setPayments([{ method, amount }]);
              onConfirm();
            }}
            disabled={isPending}
          >
            {isPending ? 'جاري...' : 'تأكيد الدفع'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function ReceiptModal({
  invoiceId,
  onClose,
}: {
  invoiceId: string;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['receipt', invoiceId],
    queryFn: () => posApi.receipt(invoiceId),
  });
  const [mode, setMode] = useState<'ask' | 'printing'>('ask');

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4 print:bg-transparent print:p-0">
      <div className="bg-slate-900 border border-white/10 rounded-2xl max-w-md w-full max-h-[90vh] overflow-hidden flex flex-col print:rounded-none print:max-w-none print:w-auto print:max-h-none print:bg-white">
        {mode === 'ask' && (
          <>
            <div className="p-5 text-center border-b border-white/10 print:hidden">
              <div className="text-5xl mb-3">✅</div>
              <div className="font-black text-white text-xl">
                تم حفظ الفاتورة
              </div>
              <div className="text-sm text-slate-400 mt-1">
                رقم الفاتورة: <span className="font-mono text-white">{(data as any)?.invoice?.invoice_no || '...'}</span>
              </div>
            </div>
            <div className="p-5 flex flex-col gap-2 print:hidden">
              <button
                className="py-3 rounded-lg bg-gradient-to-br from-brand-500 to-pink-600 text-white font-bold hover:opacity-90 flex items-center justify-center gap-2"
                onClick={() => setMode('printing')}
                disabled={isLoading}
              >
                <Printer size={18} /> طباعة الفاتورة
              </button>
              <button
                className="py-3 rounded-lg bg-white/5 text-slate-300 hover:bg-white/10 font-bold flex items-center justify-center gap-2"
                onClick={onClose}
              >
                <Save size={18} /> حفظ بدون طباعة
              </button>
            </div>
          </>
        )}

        {mode === 'printing' && (
          <>
            <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between print:hidden">
              <h3 className="font-black text-white">معاينة الفاتورة</h3>
              <div className="flex gap-2">
                <button
                  className="px-3 py-1.5 rounded bg-brand-500 text-white text-xs font-bold"
                  onClick={() => window.print()}
                  disabled={isLoading}
                >
                  🖨️ طباعة
                </button>
                <button
                  className="px-3 py-1.5 rounded bg-white/5 text-slate-300 text-xs"
                  onClick={onClose}
                >
                  إغلاق
                </button>
              </div>
            </div>
            <div className="overflow-y-auto print:overflow-visible bg-white">
              {isLoading && (
                <div className="p-12 text-center text-slate-400 print:hidden">
                  جارٍ تحميل الإيصال...
                </div>
              )}
              {data && <Receipt data={data as ReceiptData} autoPrint />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function VariantPickerModal({
  product,
  warehouseId,
  onClose,
  onPick,
}: {
  product: Product;
  warehouseId?: string;
  onClose: () => void;
  onPick: (product: Product, variant: Variant) => void;
}) {
  const { data: variants = [], isLoading } = useQuery({
    queryKey: ['variant-picker', product.id, warehouseId],
    queryFn: () => stockApi.byProduct(product.id, warehouseId),
  });
  const [selectedColor, setSelectedColor] = useState<string | null>(null);
  const [selectedSize, setSelectedSize] = useState<string | null>(null);

  // Unique colors/sizes present
  const colors = useMemo(() => {
    const set = new Map<string, number>();
    for (const v of variants) {
      if (!v.color) continue;
      set.set(v.color, (set.get(v.color) ?? 0) + Number(v.quantity_on_hand || 0));
    }
    return Array.from(set.entries()).map(([color, qty]) => ({ color, qty }));
  }, [variants]);

  const sizes = useMemo(() => {
    const set = new Map<string, number>();
    const list = selectedColor
      ? variants.filter((v) => v.color === selectedColor)
      : variants;
    for (const v of list) {
      if (!v.size) continue;
      set.set(v.size, (set.get(v.size) ?? 0) + Number(v.quantity_on_hand || 0));
    }
    return Array.from(set.entries()).map(([size, qty]) => ({ size, qty }));
  }, [variants, selectedColor]);

  // Auto-resolve: if no selection and only one color/size, pick it
  const current = useMemo(() => {
    const hasColor = colors.length > 0;
    const hasSize = sizes.length > 0;
    const c = selectedColor || (hasColor && colors.length === 1 ? colors[0].color : null);
    const s = selectedSize || (hasSize && sizes.length === 1 ? sizes[0].size : null);
    if (hasColor && !c) return null;
    if (hasSize && !s) return null;
    return (
      variants.find(
        (v) =>
          (c ? v.color === c : true) && (s ? v.size === s : true),
      ) || null
    );
  }, [variants, colors, sizes, selectedColor, selectedSize]);

  const pick = () => {
    if (!current) {
      toast.error('اختر اللون والمقاس');
      return;
    }
    if (Number(current.quantity_on_hand || 0) <= 0) {
      toast.error('هذا الصنف نافذ — لا يمكن بيعه');
      return;
    }
    onPick(product, {
      id: current.variant_id,
      product_id: product.id,
      sku: current.sku,
      barcode: current.barcode,
      color: current.color,
      size: current.size,
      cost_price: current.cost_price,
      selling_price: current.selling_price,
    } as Variant);
  };

  return (
    <ModalShell onClose={onClose} title={product.name_ar}>
      <div className="p-5 space-y-4">
        {isLoading && (
          <div className="text-center py-10 text-slate-400 text-sm">
            جارٍ تحميل الأصناف...
          </div>
        )}
        {!isLoading && variants.length === 0 && (
          <div className="text-center py-10 text-rose-300 text-sm">
            لا يوجد أصناف لهذا المنتج — أضف ألواناً ومقاسات أولاً.
          </div>
        )}

        {colors.length > 0 && (
          <div>
            <div className="text-xs text-slate-400 mb-2 font-bold">اللون</div>
            <div className="flex flex-wrap gap-2">
              {colors.map(({ color, qty }) => {
                const out = qty <= 0;
                const active = selectedColor === color;
                return (
                  <button
                    key={color}
                    disabled={out}
                    onClick={() => {
                      setSelectedColor(active ? null : color);
                      setSelectedSize(null);
                    }}
                    className={`px-4 py-2 rounded-lg text-sm font-bold border transition ${
                      out
                        ? 'bg-white/[0.02] border-white/5 text-slate-600 opacity-50 cursor-not-allowed line-through'
                        : active
                          ? 'bg-pink-500/20 border-pink-500/50 text-pink-200'
                          : 'bg-white/5 border-white/10 text-slate-200 hover:bg-white/10'
                    }`}
                  >
                    {color}
                    <span className="text-xs opacity-70 mr-1">({qty})</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {sizes.length > 0 && sizes.some((s) => s.size !== 'مقاس حر') && (
          <div>
            <div className="text-xs text-slate-400 mb-2 font-bold">المقاس</div>
            <div className="flex flex-wrap gap-2">
              {sizes.map(({ size, qty }) => {
                const out = qty <= 0;
                const active = selectedSize === size;
                return (
                  <button
                    key={size}
                    disabled={out}
                    onClick={() => setSelectedSize(active ? null : size)}
                    className={`min-w-[3.5rem] px-3 py-2 rounded-lg text-sm font-bold border transition ${
                      out
                        ? 'bg-white/[0.02] border-white/5 text-slate-600 opacity-50 cursor-not-allowed line-through'
                        : active
                          ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-200'
                          : 'bg-white/5 border-white/10 text-slate-200 hover:bg-white/10'
                    }`}
                  >
                    {size}
                    <span className="block text-[10px] opacity-70 font-normal">
                      {qty} متوفر
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {current && (
          <div className="p-3 rounded-lg bg-white/5 border border-white/10 text-sm space-y-1">
            <div className="flex justify-between">
              <span className="text-slate-400">الكود:</span>
              <span className="font-mono text-white">{current.sku}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">السعر:</span>
              <span className="font-black text-emerald-400">
                {EGP(Number(current.selling_price))}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">المتوفر:</span>
              <span
                className={`font-bold ${
                  Number(current.quantity_on_hand) <= 0
                    ? 'text-rose-400'
                    : Number(current.quantity_on_hand) <= 2
                      ? 'text-amber-300'
                      : 'text-emerald-400'
                }`}
              >
                {current.quantity_on_hand} قطعة
              </span>
            </div>
          </div>
        )}

        <div className="flex gap-2">
          <button
            className="flex-1 py-2.5 rounded-lg bg-gradient-to-br from-pink-500 to-rose-600 text-white font-bold hover:opacity-90 disabled:opacity-40"
            onClick={pick}
            disabled={
              !current || Number(current?.quantity_on_hand || 0) <= 0
            }
          >
            إضافة للفاتورة
          </button>
          <button
            className="px-4 py-2.5 rounded-lg bg-white/5 text-slate-300 hover:bg-white/10"
            onClick={onClose}
          >
            إلغاء
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function NewCustomerModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (c: Customer) => void;
}) {
  const [form, setForm] = useState({
    code: `CUS-${Date.now().toString().slice(-6)}`,
    full_name: '',
    phone: '',
    email: '',
  });
  const mutation = useMutation({
    mutationFn: () =>
      customersApi.create({
        code: form.code.trim(),
        full_name: form.full_name.trim(),
        phone: form.phone.trim() || undefined,
        email: form.email.trim() || undefined,
      } as any),
    onSuccess: (c) => onCreated(c),
    onError: (e: any) => {
      const msg = e?.response?.data?.message || 'فشل حفظ العميل';
      toast.error(Array.isArray(msg) ? msg[0] : String(msg));
    },
  });

  return (
    <ModalShell onClose={onClose} title="إضافة عميل جديد">
      <div className="p-5 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-slate-400 block mb-1">الكود</label>
            <input
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
            />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">
              الاسم *
            </label>
            <input
              autoFocus
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white"
              value={form.full_name}
              onChange={(e) =>
                setForm({ ...form, full_name: e.target.value })
              }
            />
          </div>
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">الهاتف</label>
          <input
            dir="ltr"
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            placeholder="01012345678"
          />
        </div>
        <div>
          <label className="text-xs text-slate-400 block mb-1">البريد</label>
          <input
            dir="ltr"
            type="email"
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </div>
        <div className="flex gap-2 pt-2">
          <button
            className="flex-1 py-2.5 rounded-lg bg-gradient-to-br from-brand-500 to-pink-600 text-white font-bold hover:opacity-90 disabled:opacity-40"
            onClick={() => {
              if (!form.code.trim() || !form.full_name.trim()) {
                toast.error('الكود والاسم مطلوبان');
                return;
              }
              mutation.mutate();
            }}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? 'جاري الحفظ...' : 'حفظ واستخدام للفاتورة'}
          </button>
          <button
            className="px-4 py-2.5 rounded-lg bg-white/5 text-slate-300 hover:bg-white/10"
            onClick={onClose}
          >
            إلغاء
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function ImageScanModal({
  onClose,
  onBarcode,
}: {
  onClose: () => void;
  onBarcode: (code: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const tryDetectBarcode = async (file: File) => {
    setScanning(true);
    try {
      // Use BarcodeDetector API when available (Chrome/Edge on Android + some desktop).
      const BD = (window as any).BarcodeDetector;
      if (!BD) {
        toast.error(
          'متصفحك لا يدعم مسح الباركود من صورة. استخدم زر الإدخال اليدوي.',
        );
        setScanning(false);
        return;
      }
      const detector = new BD({
        formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'qr_code', 'upc_a', 'upc_e'],
      });
      const bitmap = await createImageBitmap(file);
      const results = await detector.detect(bitmap);
      if (results && results.length > 0) {
        onBarcode(String(results[0].rawValue));
      } else {
        toast.error('لم يتم العثور على باركود في الصورة');
      }
    } catch (e: any) {
      toast.error('فشل قراءة الصورة: ' + (e?.message || 'خطأ'));
    } finally {
      setScanning(false);
    }
  };

  return (
    <ModalShell onClose={onClose} title="بحث بصورة / كاميرا">
      <div className="p-5 space-y-4">
        <div className="text-sm text-slate-300 leading-relaxed">
          التقط صورة لباركود المنتج أو ارفع صورة من جهازك — سنحاول قراءة الباركود
          تلقائياً.
        </div>

        {preview && (
          <div className="rounded-lg overflow-hidden border border-white/10">
            <img src={preview} alt="preview" className="w-full h-48 object-contain bg-slate-950" />
          </div>
        )}

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setPreview(URL.createObjectURL(f));
            tryDetectBarcode(f);
          }}
        />

        <div className="grid grid-cols-2 gap-2">
          <button
            className="py-3 rounded-lg bg-gradient-to-br from-sky-500 to-blue-600 text-white font-bold hover:opacity-90"
            onClick={() => fileRef.current?.click()}
            disabled={scanning}
          >
            📷 فتح الكاميرا
          </button>
          <button
            className="py-3 rounded-lg bg-white/10 text-white font-bold hover:bg-white/15"
            onClick={() => {
              // file input without capture → user picks from gallery
              const el = document.createElement('input');
              el.type = 'file';
              el.accept = 'image/*';
              el.onchange = () => {
                const f = el.files?.[0];
                if (!f) return;
                setPreview(URL.createObjectURL(f));
                tryDetectBarcode(f);
              };
              el.click();
            }}
            disabled={scanning}
          >
            🖼️ صورة من الجهاز
          </button>
        </div>

        {scanning && (
          <div className="text-center text-sm text-slate-400 py-2">
            جارٍ تحليل الصورة...
          </div>
        )}

        <div className="text-xs text-slate-500 bg-white/5 rounded-lg p-3">
          💡 ملاحظة: اكتشاف الباركود يعمل على المتصفحات الحديثة (Chrome/Edge).
          على أجهزة أخرى يمكنك استخدام زر الإدخال اليدوي للباركود.
        </div>
      </div>
    </ModalShell>
  );
}

function ReservationReceiptModal({
  data,
  items,
  customer,
  warehouse,
  method,
  notes,
  onClose,
}: {
  data: {
    reservation_no: string;
    total_amount: number;
    paid_amount: number;
    remaining_amount: number;
    expires_at: string;
  };
  items: Array<{
    name: string;
    sku: string;
    color: string | null;
    size: string | null;
    qty: number;
    unitPrice: number;
    total: number;
  }>;
  customer: Customer | null;
  warehouse: { name_ar: string } | null;
  method: string;
  notes: string;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'ask' | 'printing'>('ask');
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB');
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const dayStr = now.toLocaleDateString('ar-EG-u-ca-gregory', {
    weekday: 'long',
  });

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4 print:bg-transparent print:p-0">
      <div className="bg-white rounded-2xl max-w-md w-full max-h-[90vh] overflow-hidden flex flex-col print:rounded-none print:max-w-none print:w-auto print:max-h-none">
        {mode === 'ask' && (
          <>
            <div className="p-5 text-center border-b border-slate-200 print:hidden">
              <div className="text-5xl mb-2">📋</div>
              <div className="font-black text-slate-800 text-xl">
                تم إنشاء الحجز
              </div>
              <div className="text-sm text-slate-500 mt-1">
                رقم الحجز:{' '}
                <span className="font-mono font-bold text-slate-800">
                  {data.reservation_no}
                </span>
              </div>
            </div>
            <div className="p-5 flex flex-col gap-2 print:hidden">
              <button
                className="py-3 rounded-lg bg-gradient-to-br from-orange-500 to-amber-600 text-white font-bold hover:opacity-90 flex items-center justify-center gap-2"
                onClick={() => {
                  setMode('printing');
                  setTimeout(() => window.print(), 250);
                }}
              >
                <Printer size={18} /> طباعة وحفظ
              </button>
              <button
                className="py-3 rounded-lg bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 font-bold flex items-center justify-center gap-2"
                onClick={() => setMode('printing')}
              >
                👁️ معاينة قبل الطباعة
              </button>
              <button
                className="py-3 rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 font-bold flex items-center justify-center gap-2"
                onClick={onClose}
              >
                <Save size={18} /> حفظ بدون طباعة
              </button>
            </div>
          </>
        )}

        {mode === 'printing' && (
          <>
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between print:hidden">
              <h3 className="font-black text-slate-800">
                معاينة إيصال الحجز
              </h3>
              <div className="flex gap-2">
                <button
                  className="px-3 py-1.5 rounded bg-brand-500 text-white text-xs font-bold"
                  onClick={() => window.print()}
                >
                  🖨️ طباعة
                </button>
                <button
                  className="px-3 py-1.5 rounded bg-slate-100 text-slate-700 text-xs"
                  onClick={onClose}
                >
                  إغلاق
                </button>
              </div>
            </div>
            <div
              className="overflow-y-auto print:overflow-visible bg-white p-6 text-slate-800"
              style={{ fontFamily: 'Cairo, sans-serif' }}
            >
              <div className="text-center border-b-2 border-dashed border-slate-300 pb-3 mb-3">
                <div className="text-2xl font-black">إيصال حجز بعربون</div>
                <div className="text-xs text-slate-500 mt-1">
                  زهران — نظام البيع
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  {dayStr} · {dateStr} · {timeStr}
                </div>
              </div>

              <div className="space-y-1 text-sm mb-3">
                <div className="flex justify-between">
                  <span className="text-slate-500">رقم الحجز:</span>
                  <span className="font-mono font-bold">
                    {data.reservation_no}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">العميل:</span>
                  <span className="font-bold">
                    {customer?.full_name || '—'}
                  </span>
                </div>
                {customer?.phone && (
                  <div className="flex justify-between">
                    <span className="text-slate-500">الهاتف:</span>
                    <span dir="ltr" className="font-mono">
                      {customer.phone}
                    </span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-slate-500">الفرع:</span>
                  <span>{warehouse?.name_ar || '—'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">ينتهي في:</span>
                  <span className="font-bold">{data.expires_at}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">طريقة الدفع:</span>
                  <span>
                    {method === 'cash'
                      ? 'كاش'
                      : method === 'card'
                        ? 'بطاقة'
                        : method === 'instapay'
                          ? 'إنستا باي'
                          : 'تحويل بنكي'}
                  </span>
                </div>
              </div>

              <div className="border-t border-slate-200 pt-2 mb-3">
                <div className="font-bold mb-2 text-sm">الأصناف المحجوزة</div>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-slate-500">
                      <th className="text-right">الصنف</th>
                      <th className="text-center">الكمية</th>
                      <th className="text-left">السعر</th>
                      <th className="text-left">الإجمالي</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, i) => (
                      <tr key={i} className="border-t border-slate-100">
                        <td className="py-1">
                          <div className="font-bold">{it.name}</div>
                          <div className="text-slate-400 text-[10px] font-mono">
                            {it.sku}
                            {it.color ? ` · ${it.color}` : ''}
                            {it.size ? ` · مقاس ${it.size}` : ''}
                          </div>
                        </td>
                        <td className="text-center">{it.qty}</td>
                        <td className="text-left">{EGP(it.unitPrice)}</td>
                        <td className="text-left font-bold">
                          {EGP(it.total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="border-t-2 border-dashed border-slate-300 pt-3 space-y-1">
                <div className="flex justify-between">
                  <span className="text-slate-500">الإجمالي:</span>
                  <span className="font-bold">{EGP(data.total_amount)}</span>
                </div>
                <div className="flex justify-between text-emerald-700">
                  <span>المدفوع (عربون):</span>
                  <span className="font-bold">{EGP(data.paid_amount)}</span>
                </div>
                <div className="flex justify-between text-rose-700 text-lg">
                  <span className="font-bold">المتبقي:</span>
                  <span className="font-black">
                    {EGP(data.remaining_amount)}
                  </span>
                </div>
              </div>

              {notes && (
                <div className="mt-3 p-2 rounded bg-amber-50 border border-amber-200 text-xs text-amber-800">
                  <b>ملاحظات:</b> {notes}
                </div>
              )}

              <div className="text-center text-xs text-slate-400 mt-4 pt-3 border-t border-dashed border-slate-300">
                ⚠️ هذا إيصال حجز — الرجاء الاحتفاظ به لاستلام البضاعة
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-white/10 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
        dir="rtl"
      >
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <h3 className="font-black text-white">{title}</h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-white/10 text-slate-400"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
