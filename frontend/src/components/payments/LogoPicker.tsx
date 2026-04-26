import { useRef, useState } from 'react';
import { Upload, Link as LinkIcon, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { PaymentProviderLogo } from './PaymentProviderLogo';

/**
 * PR-PAY-7 — Per-account custom logo picker.
 *
 * Two input modes (operator picks either, both, or neither):
 *
 *   1. Drag-and-drop a local image file. The component reads it as a
 *      base64 data URL via FileReader and stores it in
 *      `dataUrl`. Hard cap at 80 KB *encoded* size — beyond that the
 *      DB row gets fat and snapshots in invoice_payments balloon.
 *      Accepted MIME types: image/png, image/jpeg, image/webp,
 *      image/svg+xml, image/gif.
 *
 *   2. Paste a remote logo URL. Stored verbatim in `url`. The
 *      operator is responsible for picking a URL they're allowed to
 *      hotlink (their own CDN, the brand's official asset hub, etc.).
 *
 * Resolution at render time (handled by `PaymentProviderLogo`):
 *   dataUrl > url > catalog logo_key > method group fallback > initials
 *
 * Empty state = both `dataUrl` and `url` are null/empty → the
 * provider catalog default kicks in automatically.
 */

// Drag-drop accepts ONLY raster formats. SVG is intentionally
// excluded from runtime upload because an operator-uploaded SVG could
// embed `<script>` or event handlers; while `<img src>` does sandbox
// SVG (no script execution), CodeQL flags the dataflow as
// js/xss-through-dom and we'd rather not expose the surface. SVG
// brand assets live in the bundled catalog
// (frontend/src/assets/payment-logos/) where they are vetted.
const ACCEPTED = 'image/png,image/jpeg,image/jpg,image/webp,image/gif';
const ACCEPTED_DATA_URL_PREFIX =
  /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;
// Encoded size cap. 80 KB base64 ≈ 60 KB raw — comfortable for clean
// brand badges without inflating the DB row.
const MAX_DATA_URL_BYTES = 80 * 1024;

export interface LogoPickerValue {
  dataUrl?: string | null;
  url?: string | null;
}

export interface LogoPickerProps {
  value: LogoPickerValue;
  onChange: (next: LogoPickerValue) => void;
  /** Catalog fallback shown in the preview when no custom value is set. */
  fallbackLogoKey?: string | null;
  /** Method passed to the preview for the group fallback. */
  fallbackMethod?: string | null;
  /** Display name passed to the preview's initials avatar. */
  fallbackName?: string | null;
}

export function LogoPicker({
  value,
  onChange,
  fallbackLogoKey,
  fallbackMethod,
  fallbackName,
}: LogoPickerProps) {
  const [dragOver, setDragOver] = useState(false);
  const [urlDraft, setUrlDraft] = useState(value.url ?? '');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    // Strict MIME allow-list. SVG is intentionally rejected at upload
    // (see ACCEPTED_DATA_URL_PREFIX comment).
    if (
      !/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)
    ) {
      toast.error('الملف لازم يكون صورة PNG / JPG / WebP / GIF (الـ SVG محجوز للكتالوج)');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        toast.error('تعذّر قراءة الملف');
        return;
      }
      // Encoded size guard so DB rows + receipt snapshots stay slim.
      if (result.length > MAX_DATA_URL_BYTES) {
        toast.error(
          `حجم الصورة كبير. الحد الأقصى ${(MAX_DATA_URL_BYTES / 1024).toFixed(0)} KB ` +
            `بعد الترميز (${(result.length / 1024).toFixed(1)} KB حالياً). جرّب صورة أصغر.`,
        );
        return;
      }
      // Defense in depth — reject any data URL that doesn't match the
      // raster-image pattern, even if the file picker was bypassed.
      if (!ACCEPTED_DATA_URL_PREFIX.test(result)) {
        toast.error('صيغة الصورة غير مدعومة. ارفع PNG / JPG / WebP / GIF.');
        return;
      }
      onChange({ dataUrl: result, url: value.url ?? null });
    };
    reader.onerror = () => toast.error('تعذّر قراءة الملف');
    reader.readAsDataURL(file);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = ''; // allow re-picking the same file
  };

  const commitUrl = () => {
    const trimmed = urlDraft.trim();
    if (!trimmed) {
      onChange({ dataUrl: value.dataUrl ?? null, url: null });
      return;
    }
    if (!/^https?:\/\//i.test(trimmed) && !/^\//i.test(trimmed)) {
      toast.error('الرابط لازم يبدأ بـ https://‎ أو http://‎ أو /');
      return;
    }
    onChange({ dataUrl: value.dataUrl ?? null, url: trimmed });
  };

  const clearAll = () => {
    setUrlDraft('');
    onChange({ dataUrl: null, url: null });
  };

  const hasCustom = !!(value.dataUrl || value.url);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="text-sm text-slate-600">شعار الحساب</label>
        {hasCustom && (
          <button
            type="button"
            onClick={clearAll}
            className="text-xs text-rose-600 hover:text-rose-700 inline-flex items-center gap-1"
          >
            <X className="w-3 h-3" /> استعادة الافتراضي
          </button>
        )}
      </div>

      {/* Live preview — shows whatever the resolver would render right now. */}
      <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
        <PaymentProviderLogo
          logoDataUrl={value.dataUrl ?? null}
          logoUrl={value.url ?? null}
          logoKey={fallbackLogoKey}
          method={fallbackMethod}
          name={fallbackName}
          size="lg"
          decorative
        />
        <div className="text-xs text-slate-600">
          {hasCustom ? (
            <>
              <div className="font-bold text-slate-800">شعار مخصص</div>
              <div className="opacity-70">
                {value.dataUrl
                  ? 'مرفوع كصورة (يعمل بدون إنترنت)'
                  : 'رابط خارجي'}
              </div>
            </>
          ) : (
            <>
              <div className="font-bold text-slate-800">الشعار الافتراضي</div>
              <div className="opacity-70">
                مأخوذ من كتالوج المزوّدين حسب الطريقة/المزوّد المختار.
              </div>
            </>
          )}
        </div>
      </div>

      {/* Drag-drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        className={`rounded-lg border-2 border-dashed cursor-pointer transition px-3 py-4 text-center ${
          dragOver
            ? 'border-indigo-400 bg-indigo-50'
            : 'border-slate-300 bg-white hover:border-indigo-300 hover:bg-indigo-50/40'
        }`}
      >
        <Upload className="w-5 h-5 mx-auto text-slate-500" />
        <div className="text-xs text-slate-700 mt-1.5 font-bold">
          اسحب صورة هنا أو اضغط للاختيار
        </div>
        <div className="text-[10px] text-slate-500 mt-0.5">
          PNG / JPG / WebP / GIF · الحد الأقصى {Math.floor(MAX_DATA_URL_BYTES / 1024)} KB
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED}
          onChange={onPick}
          className="hidden"
        />
      </div>

      {/* URL paste — stored verbatim as metadata.logo_url */}
      <div>
        <label className="text-xs text-slate-600 block mb-1 flex items-center gap-1">
          <LinkIcon className="w-3 h-3" />
          أو الصق رابط الشعار
        </label>
        <div className="flex gap-2">
          <input
            type="url"
            placeholder="https://example.com/logo.png"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onBlur={commitUrl}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitUrl();
              }
            }}
            dir="ltr"
            className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono"
          />
          <button
            type="button"
            onClick={commitUrl}
            className="px-3 py-2 rounded-lg text-sm bg-slate-100 hover:bg-slate-200 text-slate-700"
          >
            تأكيد
          </button>
        </div>
        <div className="text-[10px] text-slate-500 mt-1">
          الرابط الخارجي يعمل أونلاين فقط. للعمل أوفلاين على نقطة البيع، فضّل الرفع المباشر.
        </div>
      </div>
    </div>
  );
}
