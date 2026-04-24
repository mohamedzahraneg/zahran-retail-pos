# دليل النشر الإنتاجي — Zahran Retail System

> دليل شامل لنشر نظام زهران للبيع في بيئة إنتاج مستقرة على خادم Linux واحد
> أو عدة خوادم، مع التشفير، النسخ الاحتياطي التلقائي، المراقبة، والتحديثات
> بدون توقف.

---

## جدول المحتويات

1. [المعمارية العامة](#1-المعمارية-العامة)
2. [متطلبات الخادم](#2-متطلبات-الخادم)
3. [الخطوة 1 — تحضير الخادم](#3-الخطوة-1--تحضير-الخادم)
4. [الخطوة 2 — متغيرات البيئة](#4-الخطوة-2--متغيرات-البيئة)
5. [الخطوة 3 — docker-compose الإنتاجي](#5-الخطوة-3--docker-compose-الإنتاجي)
6. [الخطوة 4 — تهيئة قاعدة البيانات](#6-الخطوة-4--تهيئة-قاعدة-البيانات)
7. [الخطوة 5 — Nginx + HTTPS + Let's Encrypt](#7-الخطوة-5--nginx--https--lets-encrypt)
8. [الخطوة 6 — النسخ الاحتياطي](#8-الخطوة-6--النسخ-الاحتياطي)
9. [الخطوة 7 — المراقبة والتنبيهات](#9-الخطوة-7--المراقبة-والتنبيهات)
10. [الخطوة 8 — تأمين الإنتاج](#10-الخطوة-8--تأمين-الإنتاج)
11. [التحديث بدون توقف (Zero-downtime)](#11-التحديث-بدون-توقف-zero-downtime)
12. [التشخيص وحل المشاكل](#12-التشخيص-وحل-المشاكل)
13. [قائمة التحقق النهائية](#13-قائمة-التحقق-النهائية)

---

## 0) PRODUCTION DATABASE TRUTH (READ FIRST)

> **This section is load-bearing. Read it before doing anything else.**

### 0.1 The one source of truth

| Fact | Value |
|---|---|
| Production database | **Supabase PostgreSQL** (single-tenant) |
| Supabase project ref | `teyjynfijgwdxusbdzgz` (`zahran-pos`) |
| Region | `eu-central-2` |
| Server version | PostgreSQL **17.6** |
| Public URL | `https://pos.turathmasr.com` |
| Production VPS | `/opt/zahran` on `root@72.60.184.79` |
| Connection path | NestJS container → Supavisor pooler → Supabase Postgres |
| Migration runner | NestJS boot-time `MigrationsService` (see `backend/src/database/migrations.service.ts`) |
| Migration registry of record | `public.schema_migrations` (populated by the runner) |

### 0.2 What is NOT production

- The `db:` service in `docker-compose.yml` (Postgres 15 on an internal network) is **development only**. It is now gated behind the `dev` profile and will never start with `--profile full`.
- Supabase's native migration registry (`supabase_migrations.schema_migrations`) currently shows only the 5 bootstrap migrations. It is **not** the source of truth unless explicitly reconciled with `public.schema_migrations` (82 rows). Do not use `supabase db diff` / `supabase db reset` / Supabase branches against this project without reconciling first — you will destroy schema.

### 0.3 Invariants the stack now enforces

1. `docker-compose.yml` declares `DATABASE_URL: ${DATABASE_URL:?...}` — **docker compose refuses to start** if `DATABASE_URL` is not set. There is no longer a silent docker-Postgres fallback.
2. The `db:` service has `profiles: ["dev"]` and is absent from the API service's `depends_on`. `docker compose --profile full up -d` in production never starts it.
3. `MigrationsService.verifyProductionDatabase()` runs before any migration. In `NODE_ENV=production` it aborts boot unless **all** of the following hold:
   - `current_database() = 'postgres'` (Supabase's fixed DB name)
   - `server_version_num >= 170000` (PG 17+)
   - `schema_migrations` table exists
   - Row `filename = '071_employee_gl_dimension.sql'` is present in `schema_migrations`
4. A CI job (`compose-guard` in `.github/workflows/ci.yml`) fails if anyone reintroduces a default value for `DATABASE_URL` that allows `docker compose config` to succeed without it.

### 0.4 Verifying production safely (read-only)

On the VPS:

```bash
# 1. Containers are up
docker compose ps

# 2. DATABASE_URL is set (password masked in the output)
docker compose exec api printenv \
  | grep -E '^(DATABASE_URL|NODE_ENV|PORT)=' \
  | sed -E 's#(:)[^:@]+(@)#\1***\2#'

# 3. No local docker Postgres is running
docker compose ps | grep -i ' db ' && echo 'UNEXPECTED: local db is running' || echo 'OK: no local db'

# 4. API logs confirm the boot-time sanity check passed
docker compose logs api --since 10m \
  | grep -E 'production DB sanity verified|Wrong database|\\[Migrations\\]'
```

From any workstation with Supabase MCP / `psql` (read-only queries, mask the password):

```sql
-- Current database must be 'postgres', PG 17+
SELECT current_database(),
       current_setting('server_version_num')::int AS pg_version;

-- Migration count must be ≥ 82
SELECT count(*) FROM public.schema_migrations;

-- Sentinel migration must be present
SELECT filename, applied_at
  FROM public.schema_migrations
 WHERE filename = '071_employee_gl_dimension.sql';
```

Expected answer set:

```
current_database = postgres
pg_version       = 170006  (or higher)
count            = 82
sentinel row     = 071_employee_gl_dimension.sql | 2026-04-23 22:38:13 UTC
```

If any of these fail, **do not write** to the DB from that process — it is pointed at the wrong database.

### 0.5 Secrets handling

- `/opt/zahran/.env` is the **only** place the real `DATABASE_URL` (with password) exists. It is gitignored (`.gitignore` lines 16–22) and excluded from rsync (`scripts/deploy.sh:77`).
- `.env.production.example` at repo root documents the **shape** of the DSN (placeholders only, no password). Never commit secrets; never paste password values into commits, tickets, or docs.
- If `/opt/zahran/.env` is lost, retrieve `DATABASE_URL` from Supabase Studio → Project Settings → Database → Connection string (Transaction mode, port 6543), and restore to the file with `chmod 600`.

---

## 1) المعمارية العامة

```
                    ┌──────────────────┐
                    │    المستخدمون    │
                    │ (كاشير / مدير / أدمن) │
                    └────────┬─────────┘
                             │ HTTPS (443)
                             ▼
              ┌──────────────────────────┐
              │   Nginx / Caddy (TLS)    │  ← Let's Encrypt, HSTS, rate-limit
              └──────┬───────────────────┘
                     │
       ┌─────────────┼────────────────┐
       ▼             ▼                ▼
  ┌────────┐   ┌──────────┐     ┌──────────┐
  │  Web   │   │   API    │     │Realtime  │
  │ (Vite) │   │ (NestJS) │     │ (Socket) │
  └────────┘   └────┬─────┘     └────┬─────┘
                    │                │
              ┌─────┴────────────────┘
              ▼
   ┌────────────────┐   ┌──────────┐   ┌──────────────┐
   │ PostgreSQL 15  │   │  Redis   │   │ MinIO (صور)  │
   │  (مع pgbouncer)│   │ (cache + │   │ (S3 متوافق)   │
   └────────────────┘   │  pubsub) │   └──────────────┘
                        └──────────┘
```

**المبدأ الأساسي**: جميع الطلبات من العميل تمر عبر Nginx الذي يُشفّر
ويوجّه. PostgreSQL لا يعرض منفذاً للخارج إطلاقاً.

---

## 2) متطلبات الخادم

| المكون | الحد الأدنى | الموصى به (فرع واحد ≤ 20 كاشير) |
|---|---|---|
| CPU | 2 vCPU | 4 vCPU |
| RAM | 4 GB | 8 GB |
| Disk SSD | 40 GB | 100 GB |
| OS | Ubuntu 22.04 LTS / Debian 12 | Ubuntu 22.04 LTS |
| Docker | 24.0+ | 24.0+ |
| docker compose | v2.20+ | v2.24+ |

**للفروع المتعددة أو > 50 كاشير**: انقل قاعدة البيانات إلى خادم منفصل
مع نسخة قراءة (read replica) وخادم Redis مخصص.

---

## 3) الخطوة 1 — تحضير الخادم

```bash
# تحديث وتركيب الأدوات الأساسية
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw fail2ban htop

# تركيب Docker (السكربت الرسمي)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker

# تأكيد النسخ
docker --version
docker compose version

# Firewall: نفتح فقط 22, 80, 443
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable

# NTP: مهم جداً للتوقيع الزمني على الفواتير
sudo timedatectl set-timezone Africa/Cairo
sudo timedatectl set-ntp true

# حد أقصى لحجم السجلات (لتجنب امتلاء القرص)
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "5" }
}
EOF
sudo systemctl restart docker
```

---

## 4) الخطوة 2 — متغيرات البيئة

أنشئ ملف `.env.production` في جذر المشروع:

```bash
# ───── قاعدة البيانات ─────
DB_NAME=zahran_retail
DB_USER=zahran
DB_PASS=<كلمة-سر-قوية-هنا>               # 24+ حرف عشوائي
DB_PORT=5432
DB_HOST=db

# ───── Redis ─────
REDIS_URL=redis://redis:6379

# ───── API / Auth ─────
JWT_SECRET=<غيّرها-إلى-قيمة-عشوائية-طويلة>
JWT_REFRESH_SECRET=<مختلفة-تماماً>
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=14d
NODE_ENV=production
PORT=3000

# ───── CORS + URLs ─────
CORS_ORIGIN=https://pos.example.com
PUBLIC_URL=https://pos.example.com
API_URL=https://api.example.com

# ───── MinIO / S3 ─────
MINIO_USER=zahran
MINIO_PASS=<كلمة-سر-قوية>
S3_ENDPOINT=http://minio:9000
S3_BUCKET=zahran-uploads
S3_REGION=us-east-1

# ───── الواجهة (Vite build-time) ─────
VITE_API_URL=https://api.example.com
VITE_WS_URL=wss://api.example.com
VITE_DEFAULT_WAREHOUSE_ID=<uuid-من-قاعدة-البيانات>

# ───── Notifications ─────
WHATSAPP_PROVIDER=meta_cloud
WHATSAPP_PHONE_ID=
WHATSAPP_TOKEN=
SMS_API_URL=
SMS_API_KEY=

# ───── التشفير ─────
TLS_EMAIL=admin@example.com            # للحصول على شهادة SSL
```

> **تحذير**: لا ترفع `.env.production` إلى Git. أضفه لـ `.gitignore`.
> أنشئ الأسرار بـ:
> ```bash
> openssl rand -base64 48
> ```

---

## 5) الخطوة 3 — docker-compose الإنتاجي

ملف `docker-compose.prod.yml`:

```yaml
services:
  db:
    image: postgres:15-alpine
    restart: always
    environment:
      POSTGRES_DB: ${DB_NAME}
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASS}
      TZ: Africa/Cairo
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./database/migrations:/docker-entrypoint-initdb.d:ro
      - ./backups:/backups
    networks: [internal]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER}"]
      interval: 10s
      retries: 5
    # لا ports: — لا نكشف postgres للعالم

  redis:
    image: redis:7-alpine
    restart: always
    command: redis-server --appendonly yes --requirepass "${REDIS_PASS:-}"
    volumes: [redisdata:/data]
    networks: [internal]

  minio:
    image: minio/minio:latest
    restart: always
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_PASS}
    volumes: [miniodata:/data]
    networks: [internal]

  api:
    build:
      context: ./backend
      dockerfile: Dockerfile
    restart: always
    env_file: .env.production
    depends_on:
      db:    { condition: service_healthy }
      redis: { condition: service_started }
    networks: [internal, web]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
      interval: 30s
      retries: 5

  web:
    build:
      context: ./frontend
      dockerfile: Dockerfile
      args:
        VITE_API_URL:  ${VITE_API_URL}
        VITE_WS_URL:   ${VITE_WS_URL}
        VITE_DEFAULT_WAREHOUSE_ID: ${VITE_DEFAULT_WAREHOUSE_ID}
    restart: always
    depends_on: [api]
    networks: [web]

  nginx:
    image: nginx:stable-alpine
    restart: always
    ports: ["80:80", "443:443"]
    volumes:
      - ./deploy/nginx.conf:/etc/nginx/conf.d/default.conf:ro
      - certs:/etc/letsencrypt
      - certbot-www:/var/www/certbot
    depends_on: [api, web]
    networks: [web]

  certbot:
    image: certbot/certbot
    volumes:
      - certs:/etc/letsencrypt
      - certbot-www:/var/www/certbot
    entrypoint: >
      sh -c 'trap exit TERM;
             while :; do
               certbot renew --webroot -w /var/www/certbot --quiet;
               sleep 12h & wait $${!};
             done'

  # خدمة إرسال الإشعارات المتزامنة (اختياري، يمكن تشغيلها داخل API)
  notifications-worker:
    build: ./backend
    restart: always
    env_file: .env.production
    command: node dist/workers/notifications-worker.js
    depends_on: [db, redis]
    networks: [internal]

volumes:
  pgdata:
  redisdata:
  miniodata:
  certs:
  certbot-www:

networks:
  internal:
    driver: bridge
  web:
    driver: bridge
```

**البناء والتشغيل**:
```bash
docker compose -f docker-compose.prod.yml --env-file .env.production \
  up -d --build
```

---

## 6) الخطوة 4 — تهيئة قاعدة البيانات

### أول مرة فقط

عند أول `docker compose up`، يُشغِّل PostgreSQL جميع ملفات
`/docker-entrypoint-initdb.d/*.sql` بالترتيب الرقمي. ملفاتنا في
`database/migrations/001_*.sql` حتى `017_*.sql` تُنفَّذ تلقائياً.

```bash
# تحقق
docker compose -f docker-compose.prod.yml logs db | grep -i "schema installed"

# أدخل أول مستخدم أدمن
docker compose exec api node dist/scripts/seed-admin.js \
  --username=admin \
  --password='<كلمة-سر-قوية>' \
  --full-name='مدير النظام'
```

### Migration لاحقاً (بعد تحديث الكود)

```bash
# انسخ الملف الجديد للحاوية ونفذه
docker cp database/migrations/018_xxx.sql zahran-db-1:/tmp/
docker compose exec db psql -U ${DB_USER} -d ${DB_NAME} -f /tmp/018_xxx.sql

# أو استخدم Flyway/Sqitch (راجع الفصل 11)
```

---

## 7) الخطوة 5 — Nginx + HTTPS + Let's Encrypt

أنشئ `deploy/nginx.conf`:

```nginx
# ─── redirect http → https ───
server {
    listen 80;
    server_name pos.example.com api.example.com;
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    location / { return 301 https://$host$request_uri; }
}

# ─── الواجهة ───
server {
    listen 443 ssl http2;
    server_name pos.example.com;

    ssl_certificate     /etc/letsencrypt/live/pos.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pos.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;

    # security headers
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header Content-Security-Policy "default-src 'self'; connect-src 'self' https://api.example.com wss://api.example.com; img-src 'self' data: https:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'" always;

    client_max_body_size 20M;
    gzip on; gzip_types text/css application/javascript application/json;

    location / {
        proxy_pass http://web:80;
        proxy_set_header Host $host;
    }
}

# ─── API ───
server {
    listen 443 ssl http2;
    server_name api.example.com;

    ssl_certificate     /etc/letsencrypt/live/api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;

    add_header Strict-Transport-Security "max-age=63072000" always;

    # rate-limit على auth
    limit_req_zone $binary_remote_addr zone=auth:10m rate=10r/m;

    location /auth/ {
        limit_req zone=auth burst=5 nodelay;
        proxy_pass http://api:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    location /socket.io/ {
        proxy_pass http://api:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 300s;
    }

    location / {
        proxy_pass http://api:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

### الحصول على الشهادات لأول مرة

```bash
# شغّل Nginx بدون SSL مؤقتاً ليرد على التحقق من Let's Encrypt
docker compose -f docker-compose.prod.yml up -d nginx

# اطلب الشهادات
docker compose -f docker-compose.prod.yml run --rm certbot \
  certonly --webroot -w /var/www/certbot \
  -d pos.example.com -d api.example.com \
  --email ${TLS_EMAIL} --agree-tos --no-eff-email

# إعادة تحميل Nginx لاستخدام الشهادات الجديدة
docker compose -f docker-compose.prod.yml restart nginx
```

> **التجديد التلقائي**: حاوية `certbot` في docker-compose تُجدِّد كل 12 ساعة.

---

## 8) الخطوة 6 — النسخ الاحتياطي

### نسخة يومية تلقائية

أنشئ `deploy/backup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=/srv/backups/zahran
KEEP_DAYS=30

mkdir -p "$BACKUP_DIR"

# نسخة pg_dump مضغوطة
docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U "$DB_USER" -F c "$DB_NAME" \
  > "$BACKUP_DIR/db_${TIMESTAMP}.dump"

# نسخة من MinIO (ملفات الصور)
docker compose -f docker-compose.prod.yml exec -T minio \
  mc mirror --overwrite /data "/backups/minio_${TIMESTAMP}"

# احذف النسخ الأقدم من KEEP_DAYS
find "$BACKUP_DIR" -name "*.dump" -mtime +${KEEP_DAYS} -delete

echo "[$(date -Iseconds)] backup OK: $BACKUP_DIR"
```

```bash
chmod +x deploy/backup.sh
# cron: 02:30 يومياً
(crontab -l 2>/dev/null; echo "30 2 * * * /path/to/zahran/deploy/backup.sh >> /var/log/zahran-backup.log 2>&1") | crontab -
```

### استرجاع

```bash
# أوقف API لضمان عدم كتابة أثناء الاسترجاع
docker compose -f docker-compose.prod.yml stop api

# استرجاع قاعدة البيانات
docker compose -f docker-compose.prod.yml exec -T db \
  pg_restore -U $DB_USER -d $DB_NAME -c -1 < backup.dump

docker compose -f docker-compose.prod.yml start api
```

### نسخ غير-محلية

ارسل النسخ يومياً إلى S3/Backblaze B2:

```bash
rclone copy /srv/backups/zahran remote:zahran-backups/$(hostname)/ \
  --include "*.dump" --min-age 1h
```

---

## 9) الخطوة 7 — المراقبة والتنبيهات

### Healthcheck خارجي

```bash
# فحص بسيط كل دقيقة
* * * * * curl -sf https://api.example.com/health >/dev/null || \
  curl -s -X POST "$SLACK_WEBHOOK" -d '{"text":"⚠️ Zahran API down"}'
```

### Prometheus + Grafana (اختياري)

```yaml
# أضف إلى docker-compose.prod.yml
  prometheus:
    image: prom/prometheus:latest
    volumes: [./deploy/prometheus.yml:/etc/prometheus/prometheus.yml]
  grafana:
    image: grafana/grafana:latest
    environment:
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_PASS}
    volumes: [grafanadata:/var/lib/grafana]
```

### سجلات مركّزة

```bash
# عرض آخر 100 سطر من كل الخدمات
docker compose -f docker-compose.prod.yml logs --tail=100 -f

# فقط API
docker compose -f docker-compose.prod.yml logs -f api
```

لأنظمة الإنتاج: استخدم **Loki + Promtail** أو ارسل السجلات إلى
**Papertrail/Datadog/CloudWatch**.

---

## 10) الخطوة 8 — تأمين الإنتاج

### قائمة التأمين

- [x] **كلمات السر**: جميع أسرار `.env.production` عشوائية بطول ≥ 24 حرف
- [x] **Postgres مُغلق**: بدون `ports:` في docker-compose
- [x] **HTTPS فقط**: إعادة توجيه 80 → 443 في Nginx
- [x] **HSTS**: `max-age=63072000; includeSubDomains; preload`
- [x] **Rate-limit**: على `/auth/*` و `/pos/invoices` (منع الفواتير الوهمية)
- [x] **CSP**: تقييد المصادر الخارجية
- [x] **Cookies آمنة**: `HttpOnly, Secure, SameSite=strict` للـ refresh token
- [x] **Firewall**: UFW يُغلق كل شيء باستثناء 22/80/443
- [x] **SSH**: تعطيل كلمة السر، استخدام SSH key فقط
- [x] **fail2ban**: للحماية من brute-force على SSH
- [x] **Backup مشفّر**: ارفع النسخ الاحتياطية إلى S3 مع `gpg --encrypt`
- [x] **مراجعة RBAC**: راجع `user_roles` دورياً واحذف الصلاحيات غير المستخدمة
- [x] **Audit log**: مفعّل لتتبع كل عملية حساسة
- [x] **تشفير الاتصال الداخلي**: Postgres لا يحتاج TLS داخلياً لأنه
      معزول على الشبكة الداخلية، لكن فعِّل SSL إذا كانت على خادم منفصل

### فحص دوري

```bash
# كشف العناصر الضعيفة
docker scout cves zahran-api:latest
docker scout cves zahran-web:latest

# تحقق من إعدادات SSL
curl -s https://api.example.com | grep -i strict-transport

# تأكد من أن postgres غير مكشوف
sudo ss -tlnp | grep 5432   # يجب أن يكون فارغاً
```

---

## 11) التحديث بدون توقف (Zero-downtime)

### للواجهة (Web)
يمكن إعادة النشر فوراً بدون تأثير:
```bash
docker compose -f docker-compose.prod.yml build web
docker compose -f docker-compose.prod.yml up -d --no-deps web
```

### للـ API
استخدم نسختين متوازيتين خلف Nginx:
```yaml
api-blue:
  build: ./backend
  ...
api-green:
  build: ./backend
  ...
```
ثم في Nginx، حدِّث `upstream` من `api-blue` إلى `api-green` و `reload`.

### Migrations ترقية آمنة

1. **المرحلة الأولى (غير مُعطِّلة)**: أضف العمود/الجدول الجديد بدون NOT NULL
2. **انشر الكود الجديد** الذي يكتب إلى العمود القديم والجديد معاً
3. **ملء البيانات**: `UPDATE ... SET new_col = ...`
4. **المرحلة الثانية**: أضف NOT NULL / احذف العمود القديم

أداة مُستحسَنة: **Flyway** أو **Sqitch** لإدارة تسلسل الـ migrations:
```bash
# مثال Flyway
flyway -configFiles=flyway.conf migrate
```

---

## 12) التشخيص وحل المشاكل

| العرض | السبب المحتمل | الحل |
|---|---|---|
| `db` لا يعمل بعد `up` | schema.sql به خطأ SQL | `docker compose logs db` |
| API يعيد 502 من Nginx | API لم يبدأ أو فشل health | `docker compose logs api` |
| WebSocket لا يتصل | Nginx لا يوجه `/socket.io/` | راجع `proxy_set_header Upgrade` |
| CORS error في المتصفح | `CORS_ORIGIN` لا يطابق | تحقق من `.env.production` |
| PWA لا يتحدث | Cache القديم في متصفح الكاشير | من DevTools: Application → Clear storage |
| طباعة الإيصال مُقطّعة | قياس الورق الخاطئ في المتصفح | `@page size: 80mm auto` موجود — عيّن "Printer margins: None" |
| بطء شديد في البحث | فهرس مفقود | راجع `EXPLAIN ANALYZE` على الاستعلام |
| امتلاء القرص | سجلات Docker | `docker system prune -af --volumes` (احذر!) |

---

## 13) قائمة التحقق النهائية

قبل فتح النظام للعملاء:

### إعداد
- [ ] جميع متغيرات `.env.production` مُعبّأة وآمنة
- [ ] النطاق يشير إلى IP الخادم (A/AAAA records)
- [ ] شهادات SSL نشطة (`https://pos.example.com` تفتح بدون تحذير)
- [ ] `admin` تم إنشاؤه وكلمة السر قوية
- [ ] `loyalty.rate`, `shop.info`, `notifications.config` في جدول `settings`

### بيانات
- [ ] المستودعات (warehouses) مُعرَّفة بأسمائها الحقيقية
- [ ] ضرائب المبيعات / الـ VAT في settings
- [ ] المستخدمين (كاشير، مدير) جاهزين
- [ ] أدوار الصلاحيات (roles) مطابقة للسياسة

### تشغيل
- [ ] `docker compose ps` كل الخدمات `healthy`
- [ ] `curl -f https://api.example.com/health` يعيد 200
- [ ] `/pos` يفتح ويمكن إنشاء فاتورة تجريبية
- [ ] الطباعة تعمل على الطابعة الحقيقية (80mm)
- [ ] Offline queue مُفعّل (أطفئ الإنترنت، جرّب فاتورة)

### أمان + Continuity
- [ ] Firewall مفعّل، SSH عبر key فقط
- [ ] Backup يومي يعمل (راجع `/var/log/zahran-backup.log`)
- [ ] استرجاع Backup تجريبي نجح
- [ ] تجديد SSL تلقائي (جرِّب `certbot renew --dry-run`)
- [ ] مراقبة `/health` من خدمة خارجية (UptimeRobot/Pingdom)
- [ ] صلاحيات Audit logs مفعّلة للأدمن فقط

---

## ملاحق

### قوالب Cron مفيدة

```cron
# نسخة احتياطية يومية
30 2 * * * /srv/zahran/deploy/backup.sh >> /var/log/zahran-backup.log 2>&1

# إعادة تحميل Nginx بعد تجديد SSL
15 3 * * * docker compose -f /srv/zahran/docker-compose.prod.yml exec nginx nginx -s reload

# معالجة طابور الإشعارات كل دقيقتين
*/2 * * * * curl -s -X POST -H "Authorization: Bearer $INTERNAL_TOKEN" \
  https://api.example.com/notifications/process-queue?limit=50

# تقرير الجرد الأسبوعي
0 8 * * 1 docker compose exec api node dist/scripts/weekly-stock-report.js
```

### روابط مرجعية

- [PostgreSQL tuning](https://pgtune.leopard.in.ua/) — ضبط `postgresql.conf`
- [Let's Encrypt rate limits](https://letsencrypt.org/docs/rate-limits/)
- [OWASP API security](https://owasp.org/www-project-api-security/)
- [pgBackRest](https://pgbackrest.org/) — لنسخ متقدمة بنقطة استرجاع محدّدة

---

**راجع أيضاً**: `OFFLINE_STRATEGY.md` (عمل الكاشير بدون إنترنت)،
`README.md` (المعمارية والتطوير)، `docs/ERD.md` (مخطط قاعدة البيانات).
