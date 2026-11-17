import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  InventoryClientService,
  InventoryInvalidResponseError,
  InventoryUnavailableError,
} from '../catalog/inventory-client.service.js';
import { OutboxService } from '../common/outbox.service.js';
import { commerceConfig } from '../config/commerce.config.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/commerce-client/index.js';

/** Códigos en lista blanca (CHECK en BD): nunca se persisten mensajes, URLs, cabeceras ni tokens. */
export type FulfillmentErrorCode =
  | 'INVENTORY_UNAVAILABLE'
  | 'INVALID_RESPONSE'
  | 'RESERVATION_STATE_CONFLICT'
  | 'ORDER_RESERVATION_MISMATCH'
  | 'UNEXPECTED_ERROR';

export type FulfillmentOutcome = 'FULFILLED' | 'DEFERRED' | 'STUCK' | 'SKIPPED';

export interface FulfillmentMetrics {
  readonly pending: number;
  readonly stuck: number;
  readonly oldestPendingAgeSeconds: number;
  readonly maxFulfillmentAttempts: number;
}

/** Reconocimiento pendiente: pedido creado (COMPLETED) y Catalog aún no lo ha reconocido. */
const PENDING: Prisma.CheckoutAttemptWhereInput = {
  state: 'COMPLETED',
  inventoryFulfilledAt: null,
  orderId: { not: null },
};

export function fulfillmentErrorCode(error: unknown): FulfillmentErrorCode {
  if (error instanceof InventoryUnavailableError) return 'INVENTORY_UNAVAILABLE';
  if (error instanceof InventoryInvalidResponseError) return 'INVALID_RESPONSE';
  return 'UNEXPECTED_ERROR';
}

/** Backoff exponencial acotado: base × 2^(fallos−1), con tope. */
export function fulfillmentBackoffMs(failures: number): number {
  const exponent = Math.min(Math.max(failures - 1, 0), 30);
  return Math.min(
    commerceConfig.fulfillmentBackoffBaseMs * 2 ** exponent,
    commerceConfig.fulfillmentBackoffMaxMs,
  );
}

/**
 * DT-08 (M06.0): reconocimiento de entrega de la reserva de inventario.
 *
 * Después de la transacción C3 (pedido PAGADO creado), Commerce confirma a Catalog que la reserva
 * CONFIRMED corresponde a su pedido (`fulfill`). FULFILLED es un reconocimiento técnico, no una
 * entrega física. Si Catalog no responde, el pedido se conserva, el stock sigue descontado y el
 * reconocimiento queda pendiente para el reconciliador. Nunca se libera inventario.
 *
 * Concurrencia: cada intento toma un arrendamiento (`fulfillment_lease_owner/until`) con una
 * actualización condicional, y toda escritura posterior exige seguir siendo el propietario. Un
 * proceso que perdió el arrendamiento no puede sobrescribir el resultado de otro. La idempotencia
 * natural de Catalog (reservationId + orderId) cubre la carrera residual.
 */
@Injectable()
export class InventoryFulfillmentService {
  private readonly logger = new Logger(InventoryFulfillmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryClientService,
    private readonly outbox: OutboxService,
  ) {}

  /** Datos que C3 escribe para que el proceso que creó el pedido haga el primer intento. */
  static leaseFor(owner: string): {
    fulfillmentLeaseOwner: string;
    fulfillmentLeaseUntil: Date;
  } {
    return {
      fulfillmentLeaseOwner: owner,
      fulfillmentLeaseUntil: new Date(Date.now() + commerceConfig.fulfillmentLeaseMs),
    };
  }

  /** Candidatos libres para el reconciliador: sin arrendamiento vigente y con el backoff cumplido. */
  async dueAttempts(limit: number): Promise<string[]> {
    const now = new Date();
    const rows = await this.prisma.checkoutAttempt.findMany({
      where: { ...PENDING, AND: this.claimable(now) },
      orderBy: [
        { fulfillmentNextAttemptAt: { sort: 'asc', nulls: 'first' } },
        { updatedAt: 'asc' },
      ],
      take: limit,
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /** Toma el arrendamiento de un intento pendiente. Devuelve el propietario o `undefined`. */
  async claim(attemptId: string): Promise<string | undefined> {
    const owner = randomUUID();
    const now = new Date();
    const claimed = await this.prisma.checkoutAttempt.updateMany({
      where: { id: attemptId, ...PENDING, AND: this.claimable(now) },
      data: InventoryFulfillmentService.leaseFor(owner),
    });
    return claimed.count === 1 ? owner : undefined;
  }

  /**
   * Un intento de reconocimiento por parte del propietario del arrendamiento. Nunca lanza: los
   * fallos quedan registrados para el reconciliador y no alteran la respuesta del checkout.
   */
  async fulfill(attemptId: string, owner: string, requestId: string): Promise<FulfillmentOutcome> {
    try {
      const attempt = await this.prisma.checkoutAttempt.findFirst({
        where: { id: attemptId, ...PENDING, fulfillmentLeaseOwner: owner },
      });
      if (!attempt?.orderId) return 'SKIPPED';
      let result;
      try {
        result = await this.inventory.fulfill(attempt.reservationId, attempt.orderId, requestId);
      } catch (error: unknown) {
        return await this.defer(attempt, owner, fulfillmentErrorCode(error), requestId, error);
      }
      if (result.kind === 'conflict') {
        return await this.conflict(attempt, owner, result.code, requestId);
      }
      const done = await this.prisma.checkoutAttempt.updateMany({
        where: { id: attemptId, ...PENDING, fulfillmentLeaseOwner: owner },
        data: {
          inventoryFulfilledAt: new Date(),
          fulfillmentNextAttemptAt: null,
          fulfillmentLastError: null,
          fulfillmentLeaseOwner: null,
          fulfillmentLeaseUntil: null,
        },
      });
      if (done.count !== 1) return 'SKIPPED';
      this.logger.log({
        event: 'inventory_fulfillment_acknowledged',
        attemptId,
        requestId,
        fulfillmentAttempts: attempt.fulfillmentAttempts,
      });
      if (attempt.fulfillmentStuckSince) {
        await this.recordAlert(attempt, 'INVENTORY_FULFILLMENT_RECOVERED', 'EXITO', requestId, {
          fulfillmentAttempts: attempt.fulfillmentAttempts,
          stuckSeconds: Math.round((Date.now() - attempt.fulfillmentStuckSince.getTime()) / 1000),
        });
      }
      return 'FULFILLED';
    } catch (error: unknown) {
      // Fallo de persistencia propio: el arrendamiento vence y el reconciliador lo retomará.
      this.logger.error({
        event: 'inventory_fulfillment_unavailable',
        attemptId,
        requestId,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      return 'DEFERRED';
    }
  }

  /**
   * Declara atascados los reconocimientos pendientes que superan los reintentos o la antigüedad del
   * pedido y alerta una sola vez por intento (log de error + evento técnico en la outbox).
   */
  async detectStuck(): Promise<string[]> {
    const now = new Date();
    const candidates = await this.prisma.checkoutAttempt.findMany({
      where: {
        ...PENDING,
        fulfillmentStuckSince: null,
        OR: [
          { fulfillmentAttempts: { gte: commerceConfig.fulfillmentStuckAttempts } },
          {
            order: {
              createdAt: { lt: new Date(now.getTime() - commerceConfig.fulfillmentStuckAgeMs) },
            },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    const flagged: string[] = [];
    for (const candidate of candidates) {
      const marked = await this.prisma.checkoutAttempt.updateMany({
        where: { id: candidate.id, ...PENDING, fulfillmentStuckSince: null },
        data: { fulfillmentStuckSince: now },
      });
      if (marked.count !== 1) continue;
      flagged.push(candidate.id);
      await this.alertStuck(candidate, candidate.fulfillmentLastError ?? 'NONE', randomUUID());
    }
    return flagged;
  }

  /** Indicadores calculados desde la base de datos (fuente de verdad). */
  async metrics(): Promise<FulfillmentMetrics> {
    const now = Date.now();
    const [pending, stuck, oldest, maxAttempts] = await Promise.all([
      this.prisma.checkoutAttempt.count({ where: PENDING }),
      this.prisma.checkoutAttempt.count({
        where: { ...PENDING, fulfillmentStuckSince: { not: null } },
      }),
      this.prisma.order.findFirst({
        where: { attempt: PENDING },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      this.prisma.checkoutAttempt.aggregate({
        where: PENDING,
        _max: { fulfillmentAttempts: true },
      }),
    ]);
    return {
      pending,
      stuck,
      oldestPendingAgeSeconds: oldest ? Math.round((now - oldest.createdAt.getTime()) / 1000) : 0,
      maxFulfillmentAttempts: maxAttempts._max.fulfillmentAttempts ?? 0,
    };
  }

  private claimable(now: Date): Prisma.CheckoutAttemptWhereInput[] {
    return [
      { OR: [{ fulfillmentLeaseUntil: null }, { fulfillmentLeaseUntil: { lt: now } }] },
      { OR: [{ fulfillmentNextAttemptAt: null }, { fulfillmentNextAttemptAt: { lte: now } }] },
    ];
  }

  /** Fallo transitorio o ambiguo: se reintenta indefinidamente con backoff acotado. */
  private async defer(
    attempt: AttemptRow,
    owner: string,
    code: FulfillmentErrorCode,
    requestId: string,
    error: unknown,
  ): Promise<FulfillmentOutcome> {
    const failures = attempt.fulfillmentAttempts + 1;
    const delayMs = fulfillmentBackoffMs(failures);
    const changed = await this.prisma.checkoutAttempt.updateMany({
      where: { id: attempt.id, ...PENDING, fulfillmentLeaseOwner: owner },
      data: {
        fulfillmentAttempts: { increment: 1 },
        fulfillmentNextAttemptAt: new Date(Date.now() + delayMs),
        fulfillmentLastError: code,
        fulfillmentLeaseOwner: null,
        fulfillmentLeaseUntil: null,
      },
    });
    if (changed.count !== 1) return 'SKIPPED';
    this.logger.warn({
      event: 'inventory_fulfillment_deferred',
      attemptId: attempt.id,
      requestId,
      fulfillmentAttempts: failures,
      errorCode: code,
      errorType: error instanceof Error ? error.name : 'UnknownError',
      retryInMs: delayMs,
    });
    return 'DEFERRED';
  }

  /**
   * Conflicto semántico (estado o vinculación incompatibles): se declara atascado de inmediato y
   * se alerta. No se modifica el inventario ni el pedido; se reintenta con el backoff máximo por si
   * una intervención manual lo resuelve.
   */
  private async conflict(
    attempt: AttemptRow,
    owner: string,
    code: FulfillmentErrorCode,
    requestId: string,
  ): Promise<FulfillmentOutcome> {
    const now = new Date();
    const changed = await this.prisma.checkoutAttempt.updateMany({
      where: { id: attempt.id, ...PENDING, fulfillmentLeaseOwner: owner },
      data: {
        fulfillmentAttempts: { increment: 1 },
        fulfillmentNextAttemptAt: new Date(now.getTime() + commerceConfig.fulfillmentBackoffMaxMs),
        fulfillmentLastError: code,
        fulfillmentStuckSince: attempt.fulfillmentStuckSince ?? now,
        fulfillmentLeaseOwner: null,
        fulfillmentLeaseUntil: null,
      },
    });
    if (changed.count !== 1) return 'SKIPPED';
    if (!attempt.fulfillmentStuckSince) {
      await this.alertStuck(
        { ...attempt, fulfillmentAttempts: attempt.fulfillmentAttempts + 1 },
        code,
        requestId,
      );
    }
    return 'STUCK';
  }

  private async alertStuck(
    attempt: AttemptRow,
    lastError: string,
    requestId: string,
  ): Promise<void> {
    const metadata = {
      // El pedido existe y el stock sigue descontado: nunca se libera automáticamente.
      orderId: attempt.orderId ?? 'NONE',
      fulfillmentAttempts: attempt.fulfillmentAttempts,
      lastError,
    };
    this.logger.error({
      event: 'inventory_fulfillment_stuck',
      attemptId: attempt.id,
      requestId,
      ...metadata,
    });
    await this.recordAlert(attempt, 'INVENTORY_FULFILLMENT_STUCK', 'FALLO', requestId, metadata);
  }

  private async recordAlert(
    attempt: AttemptRow,
    eventType: 'INVENTORY_FULFILLMENT_STUCK' | 'INVENTORY_FULFILLMENT_RECOVERED',
    result: 'EXITO' | 'FALLO',
    requestId: string,
    metadata: Record<string, string | number>,
  ): Promise<void> {
    await this.outbox.record(
      { userId: attempt.userId, role: 'CLIENTE', requestId },
      { eventType, result, resourceType: 'checkout', resourceId: attempt.id, metadata },
    );
  }
}

type AttemptRow = Prisma.CheckoutAttemptGetPayload<object>;
