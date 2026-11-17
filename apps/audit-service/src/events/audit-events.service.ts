import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import type { IngestEvent } from './audit-event.validation.js';

export interface AuditEventView {
  readonly id: string;
  readonly sourceService: string;
  readonly eventType: string;
  readonly result: string;
  readonly actorId: string | null;
  readonly actorRole: string | null;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly sourceIp: string | null;
  readonly requestId: string | null;
  readonly metadata: unknown;
  readonly occurredAt: string;
  readonly receivedAt: string;
}

@Injectable()
export class AuditEventsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Idempotente: un evento ya registrado (mismo id de origen) se ignora (ON CONFLICT DO NOTHING). */
  async ingest(events: readonly IngestEvent[]): Promise<{ received: number; inserted: number }> {
    const { count } = await this.prisma.auditEvent.createMany({
      data: events.map((event) => ({ ...event })),
      skipDuplicates: true,
    });
    return { received: events.length, inserted: count };
  }

  /** Últimos eventos, del más reciente al más antiguo. Solo lectura. */
  async latest(limit: number): Promise<AuditEventView[]> {
    const rows = await this.prisma.auditEvent.findMany({
      orderBy: [{ occurredAt: 'desc' }, { receivedAt: 'desc' }],
      take: limit,
    });
    return rows.map((row) => ({
      ...row,
      occurredAt: row.occurredAt.toISOString(),
      receivedAt: row.receivedAt.toISOString(),
    }));
  }
}
