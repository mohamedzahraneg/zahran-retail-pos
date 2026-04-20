/**
 * ============================================================================
 *  Zahran Retail System — Backend API
 *  Bootstrap file: security, validation, swagger, CORS, graceful shutdown
 * ============================================================================
 */
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
  });

  // ── Security ──────────────────────────────────────────────────────────────
  app.use(helmet({ contentSecurityPolicy: false }));
  app.enableCors({
    origin: (process.env.CORS_ORIGIN || '*').split(','),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // ── Global prefixes / filters / interceptors ─────────────────────────────
  app.setGlobalPrefix('api/v1', {
    exclude: ['health', 'metrics'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());

  // ── Swagger / OpenAPI ────────────────────────────────────────────────────
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Zahran Retail API')
    .setDescription('Backend API لنظام زهران للبيع بالتجزئة (أحذية وحقائب)')
    .setVersion('1.0.0')
    .addBearerAuth()
    .addTag('auth', 'تسجيل الدخول والصلاحيات')
    .addTag('products', 'المنتجات والموديلات والمقاسات')
    .addTag('stock', 'المخزون والمستودعات')
    .addTag('pos', 'نقطة البيع والفواتير')
    .addTag('customers', 'العملاء والولاء')
    .addTag('suppliers', 'الموردون والمشتريات')
    .addTag('cash-desk', 'قسم الصندوق — القبض والدفع')
    .addTag('dashboard', 'لوحة التحكم والتقارير الذكية')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  // ── Graceful shutdown ────────────────────────────────────────────────────
  app.enableShutdownHooks();

  const port = Number(process.env.PORT || 3000);
  await app.listen(port, '0.0.0.0');
  logger.log(`🚀 Zahran API is running on http://localhost:${port}`);
  logger.log(`📚 Swagger docs at http://localhost:${port}/docs`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('💥 Failed to bootstrap Zahran backend:', err);
  process.exit(1);
});
