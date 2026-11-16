import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CartModule } from './cart/cart.module.js';
import { CheckoutModule } from './checkout/checkout.module.js';
import { NoStoreMiddleware } from './common/no-store.middleware.js';
import { RequestContextMiddleware } from './common/request-context.js';
import { SafeExceptionFilter } from './common/safe-exception.filter.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [
    ThrottlerModule.forRoot([{ name: 'commerce', ttl: 60_000, limit: 120 }]),
    DatabaseModule,
    CartModule,
    CheckoutModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: SafeExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
    // Todas las respuestas de Commerce están ligadas a la sesión (carrito, pedidos, entrega).
    consumer.apply(NoStoreMiddleware).forRoutes('*');
  }
}
