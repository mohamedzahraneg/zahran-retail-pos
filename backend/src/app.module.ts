import { Module, Controller, Get } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';

import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { Public } from './common/decorators/roles.decorator';

import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ProductsModule } from './products/products.module';
import { StockModule } from './stock/stock.module';
import { PosModule } from './pos/pos.module';
import { CustomersModule } from './customers/customers.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { CashDeskModule } from './cash-desk/cash-desk.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { ReservationsModule } from './reservations/reservations.module';
import { ReturnsModule } from './returns/returns.module';
import { ReportsModule } from './reports/reports.module';
import { ImportModule } from './import/import.module';
import { ShiftsModule } from './shifts/shifts.module';
import { StockTransfersModule } from './stock-transfers/stock-transfers.module';
import { InventoryCountsModule } from './inventory-counts/inventory-counts.module';
import { CouponsModule } from './coupons/coupons.module';
import { AlertsModule } from './alerts/alerts.module';
import { RealtimeModule } from './realtime/realtime.module';
import { SyncModule } from './sync/sync.module';
import { AccountingModule } from './accounting/accounting.module';
import { SettingsModule } from './settings/settings.module';
import { PurchasesModule } from './purchases/purchases.module';
import { CommissionsModule } from './commissions/commissions.module';
import { AuditModule } from './audit/audit.module';
import { LoyaltyModule } from './loyalty/loyalty.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SetupModule } from './setup/setup.module';
import { RecurringExpensesModule } from './recurring-expenses/recurring-expenses.module';
import { CustomerGroupsModule } from './customer-groups/customer-groups.module';
import { CategoriesModule } from './categories/categories.module';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';

@Controller()
class HealthController {
  @Public()
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

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: ['.env', '.env.local'],
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), process.env.UPLOAD_DIR || 'uploads'),
      serveRoot: '/uploads',
    }),
    DatabaseModule,

    AuthModule,
    UsersModule,
    ProductsModule,
    StockModule,
    PosModule,
    CustomersModule,
    SuppliersModule,
    CashDeskModule,
    DashboardModule,
    ReservationsModule,
    ReturnsModule,
    ReportsModule,
    ImportModule,
    ShiftsModule,
    StockTransfersModule,
    InventoryCountsModule,
    CouponsModule,
    AlertsModule,
    RealtimeModule,
    SyncModule,
    AccountingModule,
    SettingsModule,
    PurchasesModule,
    CommissionsModule,
    AuditModule,
    LoyaltyModule,
    NotificationsModule,
    SetupModule,
    RecurringExpensesModule,
    CustomerGroupsModule,
    CategoriesModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
