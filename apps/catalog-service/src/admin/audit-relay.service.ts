import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { adminConfig } from './admin.config.js';

export interface RelayRunReport {
  readonly delivered: number;
  readonly failed: boolean;
  readonly skipped: boolean;
}

const MAX_BACKOFF_MS = 60_000;

/**
 * M07 mínimo: entrega la outbox de Catalog a audit-service.
 *
 * - Idempotente: audit-service deduplica por el id del evento; un reenvío (respuesta perdida, dos
 *   réplicas o un reinicio) nunca duplica registros.
 * - Al menos una vez: solo marca `published_at` tras un 2xx; si falla, el lote se reintenta con
 *   backoff exponencial acotado.
 * - Nunca borra ni modifica el contenido de la outbox.
 */
@Injectable()
export class AuditRelayService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AuditRelayService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private failures = 0;
  private nextAttemptAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    const interval = adminConfig.relayIntervalMs();
    if (interval > 0) {
      this.timer = setInterval(() => void this.runOnce(), interval);
      this.timer.unref();
    }
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(now = Date.now()): Promise<RelayRunReport> {
    if (this.running || now < this.nextAttemptAt) {
      return { delivered: 0, failed: false, skipped: true };
    }
    this.running = true;
    try {
      const events = await this.prisma.outboxEvent.findMany({
        where: { publishedAt: null },
        orderBy: { occurredAt: 'asc' },
        take: adminConfig.relayBatchSize(),
      });
      if (events.length === 0) return { delivered: 0, failed: false, skipped: false };
      const response = await fetch(new URL('/internal/audit/events', adminConfig.auditUrl()), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(adminConfig.timeoutMs()),
        headers: {
          'Content-Type': 'application/json',
          'X-Spectra-Internal-Token': adminConfig.internalToken(),
        },
        body: JSON.stringify({
          events: events.map((event) => ({
            id: event.id,
            sourceService: 'catalog',
            eventType: event.eventType,
            result: event.result,
            actorId: event.actorId,
            actorRole: event.actorRole,
            resourceType: event.resourceType,
            resourceId: event.resourceId,
            sourceIp: event.sourceIp,
            requestId: event.requestId,
            metadata: event.metadata,
            occurredAt: event.occurredAt.toISOString(),
          })),
        }),
      });
      if (!response.ok) throw new Error(`audit status ${response.status}`);
      const marked = await this.prisma.outboxEvent.updateMany({
        where: { id: { in: events.map((event) => event.id) }, publishedAt: null },
        data: { publishedAt: new Date() },
      });
      this.failures = 0;
      this.nextAttemptAt = 0;
      return { delivered: marked.count, failed: false, skipped: false };
    } catch (error: unknown) {
      this.failures += 1;
      const delay = Math.min(1000 * 2 ** Math.min(this.failures - 1, 6), MAX_BACKOFF_MS);
      this.nextAttemptAt = now + delay;
      this.logger.warn({
        event: 'audit_relay_deferred',
        failures: this.failures,
        retryInMs: delay,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      return { delivered: 0, failed: true, skipped: false };
    } finally {
      this.running = false;
    }
  }
}
