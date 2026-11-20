import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminAccessGuard } from './auth/admin-access.guard.js';
import { RequestContextMiddleware } from './common/request-context.js';
import { SafeExceptionFilter } from './common/safe-exception.filter.js';
import { PrismaService } from './database/prisma.service.js';
import { AdminAuditEventsController } from './events/audit-events.controllers.js';
import { AuditEventsService } from './events/audit-events.service.js';
import { HealthController } from './health.controller.js';

/** Listener público: health y consulta de auditoría para ADMIN (M07 mínimo). */
@Module({
  // AWS-15: mismo límite por IP que el resto de servicios (la ingesta interna no pasa por aquí).
  imports: [ThrottlerModule.forRoot([{ name: 'audit', ttl: 60_000, limit: 120 }])],
  controllers: [HealthController, AdminAuditEventsController],
  providers: [
    PrismaService,
    AuditEventsService,
    AdminAccessGuard,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: SafeExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
