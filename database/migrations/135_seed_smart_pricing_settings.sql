-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Migration 135 : Seed smart_pricing defaults
--                          (PR-PURCHASES-P3.3)
--
--  WHAT THIS DOES
--    Seeds the nine settings keys that drive the per-purchase sale-price
--    suggestion cards (PR-PURCHASES-P3.1) so an admin can tune defaults
--    from the Settings page without a code change.
--
--    All inserts are idempotent — `ON CONFLICT (key) DO NOTHING`
--    means re-applying the migration leaves operator-edited values
--    untouched. The existing legacy seed
--    `smart_pricing.min_margin_default` from migration 013 is left
--    alone for backward compatibility; the new canonical key is
--    `smart_pricing.min_margin_pct_default`.
--
--  WHAT THIS DOES NOT DO
--    * No schema changes — only inserts rows into the existing
--      `settings` key/value table.
--    * No triggers.
--    * No mutation of `product_variants`, `variant_price_history`,
--      `purchase_items`, `purchase_extra_costs`.
--    * No journal_entries / journal_lines / cashbox_transactions /
--      stock_movements writes.
--    * No backfill of historical values, no auto-update of prices.
-- ============================================================================

INSERT INTO settings (key, value, group_name, is_public, description)
VALUES
  ('smart_pricing.competitive_markup_pct',  '15'::jsonb, 'smart_pricing', FALSE,
   'نسبة الزيادة للسعر الاقتصادي / المنافس'),
  ('smart_pricing.recommended_margin_pct',  '30'::jsonb, 'smart_pricing', FALSE,
   'هامش الربح للسعر الموصى به'),
  ('smart_pricing.high_margin_pct',         '40'::jsonb, 'smart_pricing', FALSE,
   'هامش الربح للسعر العالي'),
  ('smart_pricing.wholesale_markup_pct',    '10'::jsonb, 'smart_pricing', FALSE,
   'نسبة الزيادة لسعر الجملة'),
  ('smart_pricing.min_margin_pct_default',  '15'::jsonb, 'smart_pricing', FALSE,
   'الحد الأدنى لهامش الربح'),
  ('smart_pricing.rounding_step',           '5'::jsonb,  'smart_pricing', FALSE,
   'تقريب السعر لأقرب (1 / 5 / 10 / 25 / 50)'),
  ('smart_pricing.rounding_mode',           '"nearest"'::jsonb, 'smart_pricing', FALSE,
   'طريقة التقريب (nearest / floor / ceil)'),
  ('smart_pricing.show_wholesale_card',     'true'::jsonb,  'smart_pricing', FALSE,
   'إظهار بطاقة سعر الجملة'),
  ('smart_pricing.show_high_margin_card',   'true'::jsonb,  'smart_pricing', FALSE,
   'إظهار بطاقة الهامش العالي')
ON CONFLICT (key) DO NOTHING;
