import { Module, Global, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MigrationsService } from './migrations.service';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const logger = new Logger('Database');
        const url = cfg.get<string>('db.url');
        logger.log(`Connecting to PostgreSQL ...`);
        return {
          type: 'postgres',
          url,
          autoLoadEntities: true,
          synchronize: false,
          logging: cfg.get<boolean>('db.logging') ? 'all' : ['error', 'warn'],
          extra: {
            max: 20,
            connectionTimeoutMillis: 5000,
          },
          namingStrategy: undefined,
        };
      },
    }),
  ],
  providers: [MigrationsService],
  exports: [MigrationsService],
})
export class DatabaseModule {}
