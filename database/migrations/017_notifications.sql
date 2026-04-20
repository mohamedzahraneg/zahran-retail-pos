-- =====================================================================
-- 017_notifications.sql — WhatsApp / SMS / Email outbound notifications
-- =====================================================================
-- Dependencies: 001_extensions_and_enums, 002_rbac_users, 005_customers_suppliers,
--               006_pos_and_discounts, 007_reservations
-- =====================================================================

-- Channel and status enums
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_channel') THEN
    CREATE TYPE notification_channel AS ENUM (
      'whatsapp',
      'sms',
      'email'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_status') THEN
    CREATE TYPE notification_status AS ENUM (
      'queued',
      'sending',
      'sent',
      'failed',
      'cancelled'
    );
  END IF;
END$$;

-- Templates (store templates in the settings table as JSON, or dedicated)
CREATE TABLE IF NOT EXISTS notification_templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          TEXT UNIQUE NOT NULL,
  name_ar       TEXT NOT NULL,
  channel       notification_channel NOT NULL,
  subject       TEXT,
  body          TEXT NOT NULL,        -- handlebars-like placeholders: {{customer_name}} etc.
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE notification_templates IS 'Reusable notification bodies (handlebars placeholders like {{customer_name}})';

-- Outbound queue
CREATE TABLE IF NOT EXISTS notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel         notification_channel NOT NULL,
  recipient       TEXT NOT NULL,              -- phone (E.164) or email
  subject         TEXT,
  body            TEXT NOT NULL,
  status          notification_status NOT NULL DEFAULT 'queued',
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  provider        TEXT,                        -- e.g. 'twilio', 'meta_cloud', 'clickatell'
  provider_msg_id TEXT,
  reference_type  TEXT,                        -- 'invoice', 'reservation', 'alert', ...
  reference_id    UUID,
  template_code   TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  scheduled_at    TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications (status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_notifications_reference ON notifications (reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications (created_at DESC);

-- Trigger: update updated_at on row changes
CREATE OR REPLACE FUNCTION trg_notifications_touch()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notifications_touch ON notifications;
CREATE TRIGGER notifications_touch
  BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION trg_notifications_touch();

DROP TRIGGER IF EXISTS notification_templates_touch ON notification_templates;
CREATE TRIGGER notification_templates_touch
  BEFORE UPDATE ON notification_templates
  FOR EACH ROW EXECUTE FUNCTION trg_notifications_touch();

-- Seed default templates (Arabic)
INSERT INTO notification_templates (code, name_ar, channel, body) VALUES
  (
    'invoice.thank_you',
    'شكر على الشراء',
    'whatsapp',
    'مرحباً {{customer_name}} 👋

شكراً لتسوقك من *{{shop_name}}*!
فاتورة رقم: {{doc_no}}
الإجمالي: {{grand_total}} ج.م

نقاط الولاء المكتسبة: {{earned_points}} ⭐
رصيد نقاطك الحالي: {{loyalty_points}}

نتشرف بزيارتك مجدداً ❤'
  ),
  (
    'reservation.reminder',
    'تذكير بحجز على وشك الانتهاء',
    'whatsapp',
    'مرحباً {{customer_name}}،
لديك حجز رقم {{doc_no}} سينتهي في {{expires_at}}.
الرجاء إتمام الاستلام أو التواصل معنا.'
  ),
  (
    'reservation.ready',
    'جاهزية الطلب',
    'sms',
    'عزيزنا {{customer_name}}، طلبك رقم {{doc_no}} أصبح جاهزاً للاستلام من {{shop_name}}.'
  ),
  (
    'alert.low_stock',
    'تنبيه انخفاض المخزون',
    'whatsapp',
    '⚠ انخفاض في المخزون:
{{product_name}} (SKU: {{sku}})
الكمية الحالية: {{qty}} — المستودع: {{warehouse}}'
  )
ON CONFLICT (code) DO NOTHING;

-- Seed notification provider settings (empty — to be filled by admin)
INSERT INTO settings (key, value, description)
VALUES (
  'notifications.config',
  jsonb_build_object(
    'whatsapp', jsonb_build_object(
      'provider', 'meta_cloud',
      'api_url', '',
      'token', '',
      'phone_id', '',
      'enabled', false
    ),
    'sms', jsonb_build_object(
      'provider', 'generic_http',
      'api_url', '',
      'api_key', '',
      'sender_id', '',
      'enabled', false
    ),
    'email', jsonb_build_object(
      'enabled', false,
      'smtp_host', '',
      'smtp_port', 587,
      'smtp_user', '',
      'smtp_pass', '',
      'from', ''
    ),
    'auto_send_invoice_receipt', true,
    'auto_send_reservation_reminder', true
  ),
  'Configuration for notification providers'
)
ON CONFLICT (key) DO NOTHING;
