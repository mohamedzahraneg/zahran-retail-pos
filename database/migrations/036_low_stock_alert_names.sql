-- 036_low_stock_alert_names.sql
-- Improve the auto-generated stock alert message: show product name + SKU +
-- color + size + warehouse name instead of raw UUIDs.

CREATE OR REPLACE FUNCTION public.check_low_stock()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_product_name text;
    v_sku          text;
    v_color        text;
    v_size         text;
    v_wh_name      text;
    v_label        text;
BEGIN
    -- Fire once when the variant crosses the reorder threshold (not every row update).
    IF NEW.quantity_on_hand > NEW.reorder_point THEN
        RETURN NEW;
    END IF;
    IF OLD.quantity_on_hand IS NOT NULL
       AND OLD.quantity_on_hand <= NEW.reorder_point THEN
        -- Already alerted — skip.
        RETURN NEW;
    END IF;

    -- Resolve friendly names. All joins are LEFT to stay resilient if any
    -- reference is missing; the format() below has fallbacks.
    SELECT p.name_ar, v.sku,
           COALESCE(c.name_ar, c.name_en, v.color),
           COALESCE(s.size_label, v.size)
      INTO v_product_name, v_sku, v_color, v_size
      FROM product_variants v
      JOIN products p ON p.id = v.product_id
      LEFT JOIN colors c ON c.id = v.color_id
      LEFT JOIN sizes  s ON s.id = v.size_id
     WHERE v.id = NEW.variant_id;

    SELECT name_ar INTO v_wh_name FROM warehouses WHERE id = NEW.warehouse_id;

    -- Build "اسم المنتج · أحمر · 42 · SKU" as the display label.
    v_label := COALESCE(v_product_name, 'صنف');
    IF v_color IS NOT NULL OR v_size IS NOT NULL THEN
        v_label := v_label ||
            ' · ' || array_to_string(ARRAY_REMOVE(ARRAY[v_color, v_size], NULL), ' · ');
    END IF;
    IF v_sku IS NOT NULL THEN
        v_label := v_label || ' (' || v_sku || ')';
    END IF;

    INSERT INTO alerts (alert_type, severity, title, message, entity, entity_id, metadata)
    VALUES (
        (CASE WHEN NEW.quantity_on_hand = 0 THEN 'out_of_stock' ELSE 'low_stock' END)::alert_type,
        (CASE WHEN NEW.quantity_on_hand = 0 THEN 'critical'     ELSE 'warning' END)::alert_severity,
        CASE WHEN NEW.quantity_on_hand = 0
             THEN 'نفد المخزون: ' || v_label
             ELSE 'رصيد منخفض: ' || v_label
        END,
        format(
            'المتبقي %s قطعة في فرع %s (الحد الأدنى %s).',
            NEW.quantity_on_hand,
            COALESCE(v_wh_name, 'غير محدد'),
            NEW.reorder_point
        ),
        'stock'::entity_type,
        NEW.id,
        jsonb_build_object(
            'variant_id',    NEW.variant_id,
            'warehouse_id',  NEW.warehouse_id,
            'product_name',  v_product_name,
            'sku',           v_sku,
            'color',         v_color,
            'size',          v_size,
            'warehouse_name', v_wh_name,
            'quantity',      NEW.quantity_on_hand,
            'reorder_point', NEW.reorder_point
        )
    );
    RETURN NEW;
END;
$$;

-- Backfill existing unresolved alerts that still contain UUIDs in the message.
-- We rewrite them with friendly names using the alert's own metadata.jsonb
-- when possible, else re-resolve by looking up the variant_id in the
-- metadata or stock row.
WITH resolved AS (
  SELECT a.id,
         v.sku AS sku,
         p.name_ar AS product_name,
         COALESCE(c.name_ar, c.name_en, v.color) AS color_name,
         COALESCE(s.size_label, v.size) AS size_label,
         w.name_ar AS wh_name,
         st.quantity_on_hand AS qty,
         st.reorder_point AS reorder_pt
    FROM alerts a
    LEFT JOIN stock st ON st.id = a.entity_id AND a.entity = 'stock'
    LEFT JOIN product_variants v ON v.id = st.variant_id
    LEFT JOIN products p ON p.id = v.product_id
    LEFT JOIN colors   c ON c.id = v.color_id
    LEFT JOIN sizes    s ON s.id = v.size_id
    LEFT JOIN warehouses w ON w.id = st.warehouse_id
   WHERE a.is_resolved = FALSE
     AND a.alert_type IN ('low_stock','out_of_stock')
     AND (a.message LIKE '%variant %' OR a.message LIKE '%المخزن %-%')
)
UPDATE alerts a
   SET title = CASE WHEN a.alert_type = 'out_of_stock'
                    THEN 'نفد المخزون: ' || COALESCE(r.product_name, 'صنف')
                         || CASE WHEN r.color_name IS NOT NULL OR r.size_label IS NOT NULL
                                 THEN ' · ' || array_to_string(ARRAY_REMOVE(ARRAY[r.color_name, r.size_label], NULL), ' · ')
                                 ELSE '' END
                         || CASE WHEN r.sku IS NOT NULL THEN ' (' || r.sku || ')' ELSE '' END
                    ELSE 'رصيد منخفض: ' || COALESCE(r.product_name, 'صنف')
                         || CASE WHEN r.color_name IS NOT NULL OR r.size_label IS NOT NULL
                                 THEN ' · ' || array_to_string(ARRAY_REMOVE(ARRAY[r.color_name, r.size_label], NULL), ' · ')
                                 ELSE '' END
                         || CASE WHEN r.sku IS NOT NULL THEN ' (' || r.sku || ')' ELSE '' END
               END,
       message = format(
           'المتبقي %s قطعة في فرع %s (الحد الأدنى %s).',
           COALESCE(r.qty, 0),
           COALESCE(r.wh_name, 'غير محدد'),
           COALESCE(r.reorder_pt, 0)
       )
  FROM resolved r
 WHERE a.id = r.id;
