import { useRef, useState } from 'react';
import { Upload, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { PaymentProviderLogo } from './PaymentProviderLogo';

/**
 * PR-PAY-7 (Option C) — Per-account custom logo picker.
 *
 * Single input mode: drag-and-drop a local raster image file. URL
 * paste was removed entirely — the operator directive is "logos are
 * local files only, no hotlinks". The dropped file is read as a
 * base64 data URL via FileReader and stored in
 * `payment_accounts.metadata.logo_data_url`.
 *
 * Strict acceptance:
 *   • MIME types: image/png, image/jpeg, image/webp, image/gif.
 *     SVG is intentionally excluded from runtime upload (the bundled
 *     catalog has SVGs we wrote ourselves; operator uploads are
 *     raster-only to keep the XSS surface zero).
 *   • Encoded size cap: 80 KB. Beyond that the DB row + invoice
 *     snapshots get bulky.
 *   • Data URL prefix re-validated after FileReader to catch any
 *     browser MIME-hint bypass.
 *
 * Rendering at every UI surface goes through `PaymentProviderLogo`
 * which sanitizes again at the sink — defense in depth.
 */

const ACCEPTED = 'image/png,image/jpeg,image/jpg,image/webp,image/gif';
// Encoded size cap. 80 KB base64 ≈ 60 KB raw — comfortable for clean
// brand badges without inflating the DB row.
const MAX_DATA_URL_BYTES = 80 * 1024;
const ACCEPTED_DATA_URL_PREFIX =
  /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;

export interface LogoPickerValue {
  dataUrl?: string | null;
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
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    // Strict MIME allow-list. SVG is intentionally rejected at upload
    // time — the bundled catalog has vetted SVGs; operator uploads
    // stay raster-only.
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) {
      toast.error('الملف لازم يكون صورة PNG / JPG / WebP / GIF');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        toast.error('تعذّر قراءة الملف');
        return;
      }
      if (result.length > MAX_DATA_URL_BYTES) {
        toast.error(
          `حجم الصورة كبير. الحد الأقصى ${(MAX_DATA_URL_BYTES / 1024).toFixed(0)} KB ` +
            `بعد الترميز (${(result.length / 1024).toFixed(1)} KB حالياً). جرّب صورة أصغر.`,
        );
        return;
      }
      // Defense in depth — reject any data URL that doesn't match
      // the raster-image pattern, even if the file picker MIME hint
      // was bypassed.
      if (!ACCEPTED_DATA_URL_PREFIX.test(result)) {
        toast.error('صيغة الصورة غير مدعومة. ارفع PNG / JPG / WebP / GIF.');
        return;
      }
      onChange({ dataUrl: result });
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

  const clearAll = () => onChange({ dataUrl: null });

  const hasCustom = !!value.dataUrl;

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
                مرفوع كصورة (يعمل بدون إنترنت)
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

      {/* Drag-drop zone — the only way to provide a custom logo. */}
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
    </div>
  );
}
