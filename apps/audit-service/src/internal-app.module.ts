import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { InternalTokenGuard } from './auth/internal-token.guard.js';
import { RequestContextMiddleware } from './common/request-context.js';
import { SafeExceptionFilter } from './common/safe-exception.filter.js';
import { PrismaService } from './database/prisma.service.js';
import { InternalAuditEventsController } from './events/audit-events.controllers.js';
import { AuditEventsService } from './events/audit-events.service.js';

/** Listener interno (no publicado al host): ingesta idempotente desde las outbox. */
@Module({
  controllers: [InternalAuditEventsController],
  providers: [
    PrismaService,
    AuditEventsService,
    InternalTokenGuard,
    { provide: APP_FILTER, useClass: SafeExceptionFilter },
  ],
})
export class InternalAppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
