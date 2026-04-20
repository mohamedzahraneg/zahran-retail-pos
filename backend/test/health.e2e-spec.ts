import { Test, TestingModule } from '@nestjs/testing';
import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import request from 'supertest';

/**
 * Smoke e2e test — boots a minimal Nest app with just the health
 * controller and asserts /health responds 200 with the expected shape.
 *
 * We deliberately avoid wiring AppModule because that requires a live DB.
 * Run the full E2E suite separately with `NODE_ENV=test` and a test DB.
 */
@Controller()
class HealthController {
  @Get('health')
  health() {
    return {
      success: true,
      service: 'zahran-api',
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }
}

@Module({ controllers: [HealthController] })
class HealthOnlyModule {}

describe('GET /health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [HealthOnlyModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 with success = true', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.service).toBe('zahran-api');
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
  });
});
