/**
 * Admin-editable receipt template.
 * Stored as JSON in settings under `shop.receipt_templates` (array)
 * and the active template id under `shop.receipt_active_template`.
 */
export interface ReceiptTemplate {
  id: string;
  name: string;
  /** Paper width in mm (80 = thermal, 210 = A4). */
  paper_width_mm: number;
  /** Optional fixed height in mm. 0 / null = auto. */
  paper_height_mm?: number | null;
  /** Horizontal + vertical padding in mm. */
  padding_mm: number;

  // Typography
  font_family: string; // "'Cairo', sans-serif" etc.
  font_size_base: number; // px, e.g. 11
  font_size_title: number; // px, e.g. 16
  line_height: number; // e.g. 1.35

  // Colors
  color_text: string; // e.g. "#000"
  color_muted: string; // e.g. "#555"
  color_primary: string; // headers
  color_accent: string; // grand total
  color_divider: string; // dashed line color

  // Logo
  logo_size_mm: number; // max height of logo in mm
  logo_align: 'right' | 'center' | 'left';

  // Section toggles
  show_logo: boolean;
  show_header_note: boolean;
  show_customer: boolean;
  show_salesperson: boolean;
  show_warehouse: boolean;
  show_items_variant: boolean; // color/size under item name
  show_items_sku: boolean;
  show_profit: boolean;
  show_loyalty: boolean;
  show_terms: boolean;
  show_barcode: boolean;
  show_qr: boolean;
  show_notes: boolean;
  show_print_stamp: boolean;

  // Extra
  grand_total_boxed: boolean; // wrap grand total in a bordered box
  dashed_divider: boolean; // dashed vs solid
}

export const DEFAULT_TEMPLATES: ReceiptTemplate[] = [
  {
    id: 'compact-80',
    name: 'حراري 80 مم (Compact)',
    paper_width_mm: 80,
    paper_height_mm: null,
    padding_mm: 3,
    font_family: "'Cairo', 'Courier New', monospace",
    font_size_base: 11,
    font_size_title: 14,
    line_height: 1.35,
    color_text: '#000',
    color_muted: '#555',
    color_primary: '#000',
    color_accent: '#be185d',
    color_divider: '#000',
    logo_size_mm: 20,
    logo_align: 'center',
    show_logo: true,
    show_header_note: true,
    show_customer: true,
    show_salesperson: true,
    show_warehouse: true,
    show_items_variant: true,
    show_items_sku: true,
    show_profit: false,
    show_loyalty: true,
    show_terms: true,
    show_barcode: true,
    show_qr: true,
    show_notes: true,
    show_print_stamp: true,
    grand_total_boxed: false,
    dashed_divider: true,
  },
  {
    id: 'standard-a4',
    name: 'عادي A4 (Standard)',
    paper_width_mm: 210,
    paper_height_mm: null,
    padding_mm: 12,
    font_family: "'Cairo', 'Tajawal', sans-serif",
    font_size_base: 13,
    font_size_title: 22,
    line_height: 1.5,
    color_text: '#0f172a',
    color_muted: '#475569',
    color_primary: '#7c3aed',
    color_accent: '#be185d',
    color_divider: '#cbd5e1',
    logo_size_mm: 35,
    logo_align: 'center',
    show_logo: true,
    show_header_note: true,
    show_customer: true,
    show_salesperson: true,
    show_warehouse: true,
    show_items_variant: true,
    show_items_sku: true,
    show_profit: true,
    show_loyalty: true,
    show_terms: true,
    show_barcode: true,
    show_qr: true,
    show_notes: true,
    show_print_stamp: true,
    grand_total_boxed: true,
    dashed_divider: false,
  },
];

export const BLANK_TEMPLATE: Omit<ReceiptTemplate, 'id' | 'name'> = {
  paper_width_mm: 80,
  paper_height_mm: null,
  padding_mm: 3,
  font_family: "'Cairo', sans-serif",
  font_size_base: 11,
  font_size_title: 14,
  line_height: 1.35,
  color_text: '#000',
  color_muted: '#555',
  color_primary: '#000',
  color_accent: '#be185d',
  color_divider: '#000',
  logo_size_mm: 20,
  logo_align: 'center',
  show_logo: true,
  show_header_note: true,
  show_customer: true,
  show_salesperson: true,
  show_warehouse: true,
  show_items_variant: true,
  show_items_sku: true,
  show_profit: false,
  show_loyalty: true,
  show_terms: true,
  show_barcode: true,
  show_qr: true,
  show_notes: true,
  show_print_stamp: true,
  grand_total_boxed: false,
  dashed_divider: true,
};

export const FONT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "'Cairo', sans-serif", label: 'Cairo (افتراضي)' },
  { value: "'Tajawal', sans-serif", label: 'Tajawal' },
  { value: "'Amiri', serif", label: 'Amiri (فخم)' },
  { value: "'Courier New', monospace", label: 'Courier (كلاسيكي)' },
  { value: "Arial, sans-serif", label: 'Arial' },
];
