import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CatalogModule } from './catalog/catalog.module.js';
import { RequestContextMiddleware } from './common/request-context.js';
import { SafeExceptionFilter } from './common/safe-exception.filter.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [ThrottlerModule.forRoot([{ name: 'catalog', ttl: 60_000, limit: 120 }]), CatalogModule],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: SafeExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
