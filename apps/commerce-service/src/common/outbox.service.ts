import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/commerce-client/index.js';
import { PrismaService } from '../database/prisma.service.js';

export type AuditEventType =
  | 'ORDER_CREATED'
  | 'PAYMENT_SIMULATED_REJECTED'
  | 'CHECKOUT_STOCK_CONFLICT'
  | 'ACCESS_DENIED'
  /** M04.1: alerta técnica de operación (saga atascada) y su resolución. */
  | 'CHECKOUT_SAGA_STUCK'
  | 'CHECKOUT_SAGA_RECOVERED'
  /** DT-08: alerta técnica de reconocimiento de entrega atascado y su resolución. */
  | 'INVENTORY_FULFILLMENT_STUCK'
  | 'INVENTORY_FULFILLMENT_RECOVERED';

export interface AuditActor {
  readonly userId: string;
  readonly role: string;
  readonly requestId: string;
  readonly sourceIp?: string | undefined;
}

export interface AuditEvent {
  readonly eventType: AuditEventType;
  readonly result: 'EXITO' | 'FALLO' | 'DENEGADO';
  readonly resourceType: 'order' | 'checkout';
  readonly resourceId: string;
  /** Lista blanca: identificadores, conteos e importes. Nunca datos de entrega, tokens ni cookies (RN-30). */
  readonly metadata: Readonly<Record<string, string | number | readonly string[]>>;
}

/**
 * Outbox transaccional de Commerce (RS07). El evento se escribe en la misma transacción local que el
 * cambio de negocio; la entrega idempotente a audit-service pertenece a M07.
 */
@Injectable()
export class OutboxService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    actor: AuditActor,
    event: AuditEvent,
    transaction?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = transaction ?? this.prisma;
    await client.outboxEvent.create({
      data: {
        eventType: event.eventType,
        result: event.result,
        actorId: actor.userId,
        actorRole: actor.role,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        sourceIp: actor.sourceIp?.slice(0, 64) ?? null,
        requestId: actor.requestId,
        metadata: { ...event.metadata },
      },
    });
  }
}
