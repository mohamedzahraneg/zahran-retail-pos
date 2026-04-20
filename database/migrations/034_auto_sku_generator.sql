-- 034_auto_sku_generator.sql
-- Auto-generate product SKUs and variant SKUs.
--
--   Products:  "<TYPE>-NNNNN"            e.g. SH-00042  (shoes)
--                                              BG-00007  (bags)
--                                              AC-00013  (accessories)
--   Variants:  "<product.sku_root>-<COLOR><SIZE>"
--                                              SH-00042-RD42
--                                              BG-00007-BLFREE
--
-- Both SPs are idempotent: if a row's sku is already set, the caller should
-- keep it. These just return the next available value on demand.

-- ─── fn_next_product_sku(type_code) ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_next_product_sku(p_type text)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    v_prefix text;
    v_next   int;
    v_sku    text;
BEGIN
    v_prefix := CASE lower(COALESCE(p_type, ''))
        WHEN 'shoe'       THEN 'SH'
        WHEN 'bag'        THEN 'BG'
        WHEN 'accessory'  THEN 'AC'
        ELSE 'PR'
    END;

    SELECT COALESCE(MAX(
        CASE
            WHEN sku_root ~ ('^' || v_prefix || '-[0-9]+$')
                THEN substring(sku_root FROM '[0-9]+$')::int
            ELSE 0
        END
    ), 0) + 1
      INTO v_next
      FROM products;

    v_sku := v_prefix || '-' || lpad(v_next::text, 5, '0');
    RETURN v_sku;
END;
$$;

-- ─── fn_next_variant_sku(product_id, color_id, size_id) ───────────────────
CREATE OR REPLACE FUNCTION public.fn_next_variant_sku(
    p_product_id uuid,
    p_color_id   uuid,
    p_size_id    uuid
) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    v_root       text;
    v_color_code text;
    v_size_code  text;
    v_base       text;
    v_sku        text;
    v_try        int := 0;
BEGIN
    SELECT COALESCE(sku_root, 'PR-' || substring(id::text, 1, 6))
      INTO v_root
      FROM products WHERE id = p_product_id;
    IF v_root IS NULL THEN
        RAISE EXCEPTION 'Product % not found', p_product_id;
    END IF;

    -- Color code: prefer an explicit code column (en/ar), fall back to first
    -- two letters of the English name upcased, fall back to first 2 hex chars.
    IF p_color_id IS NULL THEN
        v_color_code := 'CL';
    ELSE
        SELECT COALESCE(
            NULLIF(upper(substring(regexp_replace(COALESCE(name_en, name_ar, ''), '\s+', '', 'g'), 1, 2)), ''),
            NULLIF(upper(replace(COALESCE(hex_code, ''), '#', '')), ''),
            'CL'
        )
          INTO v_color_code
          FROM colors WHERE id = p_color_id;
        IF v_color_code IS NULL THEN v_color_code := 'CL'; END IF;
    END IF;
    -- keep only alnum, max 3 chars
    v_color_code := substring(regexp_replace(v_color_code, '[^A-Za-z0-9]', '', 'g'), 1, 3);

    -- Size code: use size_label raw (e.g. "42", "M"), else "FREE"
    IF p_size_id IS NULL THEN
        v_size_code := 'FREE';
    ELSE
        SELECT COALESCE(
            NULLIF(upper(regexp_replace(COALESCE(size_label, ''), '[^A-Za-z0-9]', '', 'g')), ''),
            'FREE'
        )
          INTO v_size_code
          FROM sizes WHERE id = p_size_id;
        IF v_size_code IS NULL THEN v_size_code := 'FREE'; END IF;
    END IF;
    v_size_code := substring(v_size_code, 1, 6);

    v_base := v_root || '-' || v_color_code || v_size_code;
    v_sku := v_base;

    -- Disambiguate on collision (rare — e.g. two colors normalising to same 2 letters)
    WHILE EXISTS (SELECT 1 FROM product_variants WHERE sku = v_sku) LOOP
        v_try := v_try + 1;
        v_sku := v_base || '-' || v_try::text;
        IF v_try > 50 THEN
            RAISE EXCEPTION 'Could not generate unique variant sku from %', v_base;
        END IF;
    END LOOP;

    RETURN v_sku;
END;
$$;

-- ─── Backfill: fill empty sku_root / variant sku on existing rows ─────────
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT id, type FROM products
         WHERE sku_root IS NULL OR sku_root = ''
    LOOP
        UPDATE products SET sku_root = fn_next_product_sku(r.type) WHERE id = r.id;
    END LOOP;

    FOR r IN
        SELECT id, product_id, color_id, size_id FROM product_variants
         WHERE sku IS NULL OR sku = ''
    LOOP
        UPDATE product_variants
           SET sku = fn_next_variant_sku(r.product_id, r.color_id, r.size_id)
         WHERE id = r.id;
    END LOOP;
END $$;

-- ─── BEFORE INSERT trigger on products: auto-fill sku_root when blank ─────
CREATE OR REPLACE FUNCTION public.fn_products_autogen_sku()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.sku_root IS NULL OR NEW.sku_root = '' THEN
        NEW.sku_root := fn_next_product_sku(NEW.type);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_autogen_sku ON products;
CREATE TRIGGER trg_products_autogen_sku
    BEFORE INSERT ON products
    FOR EACH ROW EXECUTE FUNCTION fn_products_autogen_sku();

-- ─── BEFORE INSERT trigger on product_variants: auto-fill sku + barcode ───
CREATE OR REPLACE FUNCTION public.fn_variants_autogen_sku()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- Resolve color_id / size_id from the string aliases when only those
    -- were supplied (the API accepts either shape).
    IF NEW.color_id IS NULL AND NEW.color IS NOT NULL THEN
        SELECT id INTO NEW.color_id FROM colors
         WHERE lower(name_ar) = lower(NEW.color) OR lower(name_en) = lower(NEW.color)
         LIMIT 1;
    END IF;
    IF NEW.size_id IS NULL AND NEW.size IS NOT NULL THEN
        SELECT id INTO NEW.size_id FROM sizes
         WHERE lower(size_label) = lower(NEW.size)
         LIMIT 1;
    END IF;

    IF NEW.sku IS NULL OR NEW.sku = '' THEN
        NEW.sku := fn_next_variant_sku(NEW.product_id, NEW.color_id, NEW.size_id);
    END IF;
    -- Auto-generate a simple numeric barcode when missing: EAN-ish 13 digits
    -- derived from extracting digits of the sku + padding. If the variant
    -- already has a barcode we keep it; if not, fabricate one.
    IF NEW.barcode IS NULL OR NEW.barcode = '' THEN
        NEW.barcode :=
            lpad(
                CAST(
                    ('x' || substring(md5(NEW.product_id::text || NEW.color_id::text ||
                           COALESCE(NEW.size_id::text, 'free') ||
                           floor(extract(epoch from now()))::text), 1, 12))::bit(48)::bigint % 10000000000000
                AS text), 13, '0'
            );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_variants_autogen_sku ON product_variants;
CREATE TRIGGER trg_variants_autogen_sku
    BEFORE INSERT ON product_variants
    FOR EACH ROW EXECUTE FUNCTION fn_variants_autogen_sku();
