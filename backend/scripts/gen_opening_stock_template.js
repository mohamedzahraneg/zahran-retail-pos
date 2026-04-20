// Generate a rich opening-stock Excel template with full product data + inline instructions.
// Run with: node /tmp/gen_opening_stock_template.js
const ExcelJS = require('exceljs');
const path = require('path');

(async () => {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Zahran POS';
  wb.created = new Date();

  // ══════════════════════════════════════════════════════════════════════
  // Sheet 1: OpeningStock (the data the user fills in)
  // ══════════════════════════════════════════════════════════════════════
  const sheet = wb.addWorksheet('OpeningStock', {
    views: [{ rightToLeft: true, state: 'frozen', xSplit: 0, ySplit: 2 }],
  });

  // Row 1 uses English keys — the importer reads these. Row 2 has the
  // Arabic label + hint the user sees.
  sheet.columns = [
    { header: 'product_name', key: 'product_name', width: 30 },
    { header: 'sku_root', key: 'sku_root', width: 18 },
    { header: 'type', key: 'type', width: 14 },
    { header: 'category', key: 'category', width: 18 },
    { header: 'supplier', key: 'supplier', width: 18 },
    { header: 'color', key: 'color', width: 12 },
    { header: 'size', key: 'size', width: 10 },
    { header: 'uom', key: 'uom', width: 10 },
    { header: 'barcode', key: 'barcode', width: 18 },
    { header: 'cost_price', key: 'cost_price', width: 14 },
    { header: 'selling_price', key: 'selling_price', width: 14 },
    { header: 'quantity', key: 'quantity', width: 10 },
    { header: 'warehouse_code', key: 'warehouse_code', width: 14 },
    { header: 'notes', key: 'notes', width: 30 },
  ];

  // Row 1: header styling
  const header = sheet.getRow(1);
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFEC4899' },
    };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = { bottom: { style: 'thin' } };
  });
  header.height = 32;

  // Example rows (users can delete or overwrite before upload)
  sheet.addRow({
    product_name: 'حذاء سهرة موديل 204',
    sku_root: 'SHO-204',
    type: 'shoe',
    category: 'أحذية سهرة',
    supplier: 'مورد القاهرة',
    color: 'أسود',
    size: '38',
    uom: 'pair',
    barcode: '6201234567890',
    cost_price: 400,
    selling_price: 850,
    quantity: 5,
    warehouse_code: 'ZHR-01',
    notes: 'جرد افتتاحي',
  });
  sheet.addRow({
    product_name: 'حذاء سهرة موديل 204',
    sku_root: 'SHO-204',
    type: 'shoe',
    category: 'أحذية سهرة',
    supplier: 'مورد القاهرة',
    color: 'ذهبي',
    size: '37',
    uom: 'pair',
    barcode: '',
    cost_price: 400,
    selling_price: 850,
    quantity: 3,
    warehouse_code: 'ZHR-01',
    notes: '',
  });
  sheet.addRow({
    product_name: 'شنطة يد فاخرة',
    sku_root: 'BAG-205',
    type: 'bag',
    category: 'شنط',
    supplier: '',
    color: 'بني',
    size: '',
    uom: 'piece',
    barcode: '',
    cost_price: 550,
    selling_price: 1200,
    quantity: 4,
    warehouse_code: 'ZHR-01',
    notes: '',
  });

  // ══════════════════════════════════════════════════════════════════════
  // Sheet 2: Instructions
  // ══════════════════════════════════════════════════════════════════════
  const info = wb.addWorksheet('تعليمات', {
    views: [{ rightToLeft: true }],
  });
  info.columns = [
    { header: '', width: 2 },
    { header: '', width: 90 },
  ];

  const lines = [
    '',
    ['📝 كيف تستورد المخزون الافتتاحي', 'title'],
    '',
    ['الملف الحالي هو قالب جاهز. افتح ورقة (OpeningStock) وعبّئ البيانات بدءاً من السطر الثالث.', ''],
    ['يمكنك حذف الصفوف التجريبية (من 3 إلى 5) قبل الرفع إذا لم تكن بحاجة إليها.', ''],
    '',
    ['الأعمدة المطلوبة (لا يمكن تركها فارغة):', 'section'],
    '  • اسم المنتج *',
    '  • SKU رئيسي * — يجب أن يكون فريداً؛ مثال: SHO-204',
    '  • النوع * — إحدى القيم: shoe / bag / accessory',
    '  • اللون *',
    '  • سعر التكلفة *',
    '  • سعر البيع *',
    '  • الكمية *',
    '  • كود الفرع * — مثال: ZHR-01',
    '',
    ['الأعمدة الاختيارية:', 'section'],
    '  • المجموعة / القسم — إن لم تكن موجودة يتم إنشاؤها تلقائياً',
    '  • المورّد — يربط المنتج بمورد معيّن',
    '  • المقاس — مطلوب فقط للأحذية (37 / 38 / 39 ...). للشنط والإكسسوار اتركه فارغاً.',
    '  • الوحدة — الافتراضي piece',
    '  • الباركود',
    '  • ملاحظات',
    '',
    ['💡 نصائح مهمة:', 'section'],
    '  • كل صف = صنف واحد (لون + مقاس). لو المنتج له 3 ألوان × 4 مقاسات = 12 صفاً.',
    '  • استخدم نفس SKU رئيسي + نفس اسم المنتج لكل الصفوف الخاصة بنفس المنتج.',
    '  • الأسعار تكون بالجنيه المصري، رقمية فقط (لا تكتب "ج.م").',
    '  • الكميات أرقام صحيحة موجبة أو صفر.',
    '',
    ['✅ بعد الرفع:', 'section'],
    '  1. اضغط "تحقق من الملف" أولاً لرؤية أي أخطاء.',
    '  2. أصلح الأخطاء وأعد الرفع.',
    '  3. اضغط "تطبيق الاستيراد" للتنفيذ النهائي.',
    '  4. سيتم إنشاء المنتجات الجديدة + الأصناف (variants) + المخزون الافتتاحي.',
  ];

  lines.forEach((line) => {
    if (!line) {
      info.addRow([]);
      return;
    }
    const isArr = Array.isArray(line);
    const text = isArr ? line[0] : line;
    const style = isArr ? line[1] : '';
    const row = info.addRow(['', text]);
    const c = row.getCell(2);
    if (style === 'title') {
      c.font = { bold: true, size: 18, color: { argb: 'FFEC4899' } };
      row.height = 30;
    } else if (style === 'section') {
      c.font = { bold: true, size: 13, color: { argb: 'FF1E293B' } };
      c.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFCE7F3' },
      };
      row.height = 22;
    } else {
      c.font = { size: 11, color: { argb: 'FF475569' } };
      c.alignment = { wrapText: true };
    }
  });

  const out = path.join(
    '/Users/mohamedzahran/documents/Claude/Projects/Zahran/frontend/public/templates/zahran_opening_stock_template.xlsx',
  );
  await wb.xlsx.writeFile(out);
  console.log('✅ Generated:', out);
})();
