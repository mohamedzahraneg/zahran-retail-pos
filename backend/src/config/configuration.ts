/**
 * Central configuration loader — reads env vars with sensible defaults
 */
export default () => ({
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),

  db: {
    url:
      process.env.DATABASE_URL ||
      `postgres://${process.env.DB_USER || 'zahran'}:${process.env.DB_PASS || 'change_me_strong'}@${process.env.DB_HOST || 'db'}:${process.env.DB_PORT || '5432'}/${process.env.DB_NAME || 'zahran_retail'}`,
    synchronize: false, // schema managed by SQL migrations
    logging: process.env.DB_LOGGING === 'true',
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://redis:6379',
  },

  s3: {
    endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
    key: process.env.S3_KEY || 'zahran',
    secret: process.env.S3_SECRET || 'change_me_strong',
    bucket: process.env.S3_BUCKET || 'zahran-media',
  },

  jwt: {
    secret:
      process.env.JWT_SECRET ||
      'please_change_to_a_long_random_string_at_least_32_chars',
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
    refreshDays: parseInt(process.env.REFRESH_TOKEN_DAYS || '14', 10),
  },

  business: {
    tz: process.env.TZ || 'Africa/Cairo',
    currency: process.env.DEFAULT_CURRENCY || 'EGP',
    defaultWarehouseCode: process.env.DEFAULT_WAREHOUSE_CODE || 'ZHR-01',
    taxRate: parseFloat(process.env.DEFAULT_TAX_RATE || '0'),
  },

  alerts: {
    lowStockThreshold: parseInt(
      process.env.ALERT_LOW_STOCK_THRESHOLD || '5',
      10,
    ),
    cashMismatchEgp: parseFloat(process.env.ALERT_CASH_MISMATCH_EGP || '50'),
  },

  offline: {
    batchSize: parseInt(process.env.OFFLINE_SYNC_BATCH_SIZE || '100', 10),
    maxRetry: parseInt(process.env.OFFLINE_MAX_RETRY || '5', 10),
  },

  cors: {
    origin: process.env.CORS_ORIGIN || '*',
  },
});
