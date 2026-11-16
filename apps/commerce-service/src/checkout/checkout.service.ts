import { randomBytes, randomUUID } from 'node:crypto';
import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  CheckoutConflictLine,
  CheckoutSummary,
  OrderConfirmation,
  ShippingDetails,
  StockReservationLine,
} from '@spectra/contracts';
import {
  type CheckoutAttempt,
  Prisma,
  type CheckoutState,
} from '../generated/commerce-client/index.js';
import { CatalogClientService } from '../catalog/catalog-client.service.js';
import {
  InventoryClientService,
  InventoryUnavailableError,
} from '../catalog/inventory-client.service.js';
import { type AuditActor, OutboxService } from '../common/outbox.service.js';
import { commerceConfig } from '../config/commerce.config.js';
import { PrismaService } from '../database/prisma.service.js';
import type { PlaceOrderDto } from './checkout.dto.js';
import {
  type AttemptLine,
  orderTotals,
  paymentReference,
  priceSummary,
  requestHash,
  shippingFrom,
} from './checkout.helpers.js';

export const INFLIGHT_STATES: readonly CheckoutState[] = ['STARTED', 'RESERVED', 'CONFIRMED'];

export interface PlaceOutcome {
  readonly status: 200 | 201;
  readonly order: OrderConfirmation;
}

export type ReconcileResult = 'SKIPPED' | 'COMPLETED' | 'ABORTED' | 'DEFERRED';

type OrderWithItems = Prisma.OrderGetPayload<{ include: { items: true } }>;

/** El arrendamiento del intento pasó a otro proceso (reconciliador o reintento). */
class LeaseLostError extends Error {
  constructor() {
    super('checkout lease lost');
    this.name = 'LeaseLostError';
  }
}

/** Las líneas confirmadas por Catalog no coinciden con el intento: requiere intervención. */
class ReservationMismatchError extends Error {
  constructor() {
    super('reservation lines mismatch');
    this.name = 'ReservationMismatchError';
  }
}

export type RecoveryErrorCode =
  'INVENTORY_UNAVAILABLE' | 'RESERVATION_MISMATCH' | 'PERSISTENCE_ERROR' | 'UNEXPECTED_ERROR';

export interface SagaMetrics {
  readonly inflight: { STARTED: number; RESERVED: number; CONFIRMED: number };
  readonly inflightTotal: number;
  readonly stuck: number;
  readonly oldestInflightAgeSeconds: number;
  readonly maxRecoveryAttempts: number;
  readonly nextRecoveryInSeconds: number | null;
}

/** Clasificación en lista blanca: nunca se persisten mensajes de error ni datos. */
export function recoveryErrorCode(error: unknown): RecoveryErrorCode {
  if (error instanceof InventoryUnavailableError) return 'INVENTORY_UNAVAILABLE';
  if (error instanceof ReservationMismatchError) return 'RESERVATION_MISMATCH';
  const name = error instanceof Error ? error.name : '';
  if (name.startsWith('PrismaClient')) return 'PERSISTENCE_ERROR';
  return 'UNEXPECTED_ERROR';
}

export function recoveryBackoffMs(recoveryAttempts: number): number {
  const exponent = Math.min(Math.max(recoveryAttempts - 1, 0), 30);
  return Math.min(
    commerceConfig.recoveryBackoffBaseMs * 2 ** exponent,
    commerceConfig.recoveryBackoffMaxMs,
  );
}

function pending(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'CHECKOUT_PENDING',
    message: 'La confirmación quedó pendiente; reintenta en unos segundos',
  });
}

function inProgress(): ConflictException {
  return new ConflictException({
    code: 'CHECKOUT_IN_PROGRESS',
    message: 'Ya hay una confirmación en curso para este carrito',
  });
}

function cartEmpty(): ConflictException {
  return new ConflictException({
    code: 'CHECKOUT_CART_EMPTY',
    message: 'El carrito no tiene productos para confirmar',
  });
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'P2002';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function attemptLines(attempt: CheckoutAttempt): AttemptLine[] {
  const value = attempt.lines;
  if (!Array.isArray(value)) throw new Error('attempt lines');
  return value.map((entry) => {
    const record = entry as Record<string, unknown>;
    const productId = record['productId'];
    const quantity = record['quantity'];
    if (typeof productId !== 'string' || typeof quantity !== 'number') {
      throw new Error('attempt lines');
    }
    return { productId, quantity };
  });
}

function pricedLines(attempt: CheckoutAttempt): StockReservationLine[] {
  const value = attempt.pricedLines;
  if (!Array.isArray(value)) throw new Error('priced lines');
  return value.map((entry) => {
    const record = entry as Record<string, unknown>;
    const { productId, name, quantity, unitPrice } = record;
    if (
      typeof productId !== 'string' ||
      typeof name !== 'string' ||
      typeof quantity !== 'number' ||
      typeof unitPrice !== 'string'
    ) {
      throw new Error('priced lines');
    }
    return { productId, name, quantity, unitPrice };
  });
}

function shippingOf(attempt: CheckoutAttempt): ShippingDetails {
  const record = attempt.shipping as Record<string, unknown> | null;
  if (!record) throw new Error('attempt shipping');
  const { recipientName, phone, department, municipality, address, references } = record;
  if (
    typeof recipientName !== 'string' ||
    typeof phone !== 'string' ||
    typeof department !== 'string' ||
    typeof municipality !== 'string' ||
    typeof address !== 'string' ||
    (references !== undefined && typeof references !== 'string')
  ) {
    throw new Error('attempt shipping');
  }
  return {
    recipientName,
    phone,
    department,
    municipality,
    address,
    ...(references ? { references } : {}),
  };
}

/** Las líneas confirmadas por Catalog deben coincidir exactamente con las del intento. */
function sameLines(expected: readonly AttemptLine[], actual: readonly StockReservationLine[]) {
  if (expected.length !== actual.length) return false;
  const byId = new Map(actual.map((line) => [line.productId, line.quantity]));
  return expected.every((line) => byId.get(line.productId) === line.quantity);
}

/**
 * Orquestador de la saga de checkout (M04, ADR-M04-01). Cada paso es una transacción ACID local:
 *
 *   C1 Commerce: intento STARTED (idempotente por usuario + Idempotency-Key, carrito congelado)
 *   R  Catalog:  reserva todo-o-nada con descuento condicional de stock
 *   K  Catalog:  confirmación (punto de no retorno; rechaza reservas vencidas)
 *   C3 Commerce: pedido PAGADO + líneas con precio congelado + carrito CONVERTIDO + outbox
 *
 * Compensación: liberar la reserva (idempotente) si la saga no llega a K. Tras K, C3 es local y
 * siempre se completa hacia adelante, incluso desde el reconciliador tras un reinicio.
 */
@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogClientService,
    private readonly inventory: InventoryClientService,
    private readonly outbox: OutboxService,
  ) {}

  async summary(userId: string, requestId: string): Promise<CheckoutSummary> {
    const cart = await this.prisma.cart.findFirst({
      where: { userId, status: 'ACTIVO' },
      include: { items: { orderBy: { productId: 'asc' } } },
    });
    if (!cart || cart.items.length === 0) throw cartEmpty();
    const lines = cart.items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
    }));
    const snapshots = await this.catalog.snapshot(
      lines.map((line) => line.productId),
      requestId,
    );
    const priced = priceSummary(lines, snapshots);
    const inflight = await this.prisma.checkoutAttempt.count({
      where: { cartId: cart.id, state: { in: [...INFLIGHT_STATES] } },
    });
    return {
      cartId: cart.id,
      items: priced.lines,
      itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
      total: priced.total,
      currency: 'GTQ',
      fingerprint: priced.fingerprint,
      checkoutAllowed: priced.allAvailable && inflight === 0,
      checkoutInProgress: inflight > 0,
    };
  }

  async place(actor: AuditActor, key: string, dto: PlaceOrderDto): Promise<PlaceOutcome> {
    const hash = requestHash(dto);
    const existing = await this.findByKey(actor.userId, key);
    if (existing) return this.replay(existing, hash, actor, dto, 0);
    const started = await this.begin(actor, key, dto, hash, false);
    if (started.kind === 'replay') return this.replay(started.attempt, hash, actor, dto, 0);
    return this.drive(started.attempt, started.owner, actor);
  }

  async order(actor: AuditActor, orderId: string): Promise<OrderConfirmation> {
    // RN-20: el filtro de propiedad forma parte de la consulta, nunca solo de la UI.
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId: actor.userId },
      include: { items: { orderBy: { productId: 'asc' } } },
    });
    if (order) return this.present(order);
    const foreign = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (foreign) {
      await this.outbox.record(actor, {
        eventType: 'ACCESS_DENIED',
        result: 'DENEGADO',
        resourceType: 'order',
        resourceId: orderId,
        metadata: { operation: 'GET /orders/:id' },
      });
    }
    // Respuesta idéntica para pedido ajeno o inexistente (CA-M05-02, RN-21).
    throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Pedido no encontrado' });
  }

  /**
   * Reconciliación de un intento cuyo arrendamiento venció (proceso caído, timeout o reinicio).
   * Hacia atrás si Catalog no confirmó la reserva; hacia adelante si ya la confirmó.
   *
   * M04.1: nunca abandona una saga ni libera stock confirmado. Un fallo programa el siguiente
   * intento con backoff exponencial acotado y registra un código de error en lista blanca; la
   * detección de sagas atascadas (`detectStuck`) alerta en lugar de reintentar en silencio.
   */
  async reconcile(attemptId: string, requestId: string): Promise<ReconcileResult> {
    const owner = randomUUID();
    const now = new Date();
    const claimed = await this.prisma.checkoutAttempt.updateMany({
      where: {
        id: attemptId,
        state: { in: [...INFLIGHT_STATES] },
        AND: [
          { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
          { OR: [{ nextRecoveryAt: null }, { nextRecoveryAt: { lte: now } }] },
        ],
      },
      data: {
        leaseOwner: owner,
        leaseUntil: new Date(now.getTime() + commerceConfig.checkoutLeaseMs),
        recoveryAttempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) return 'SKIPPED';
    const attempt = await this.prisma.checkoutAttempt.findUniqueOrThrow({
      where: { id: attemptId },
    });
    const actor: AuditActor = { userId: attempt.userId, role: 'CLIENTE', requestId };
    try {
      let current = attempt;
      if (current.state !== 'CONFIRMED') {
        let state = await this.inventory.state(current.reservationId, requestId);
        if (state.status === 'PENDING') {
          state = await this.inventory.release(current.reservationId, requestId);
          if (state.status === 'CONFIRMED') {
            state = await this.inventory.state(current.reservationId, requestId);
          }
        } else if (state.status === 'NOT_FOUND') {
          // Lápida en Catalog: una reserva retrasada en la red ya no podrá aplicarse.
          state = await this.inventory.release(current.reservationId, requestId);
        }
        if (state.status !== 'CONFIRMED') {
          await this.terminate(current, owner, 'ABORTED', 'RECOVERY_RELEASED', undefined);
          this.logger.warn({ event: 'checkout_compensated', attemptId, requestId });
          await this.recordRecovered(attempt, 'ABORTED', actor);
          return 'ABORTED';
        }
        if (!sameLines(attemptLines(current), state.lines)) {
          throw new ReservationMismatchError();
        }
        current = await this.transition(current, owner, 'CONFIRMED', {
          pricedLines: state.lines.map((line) => ({ ...line })),
        });
      }
      await this.complete(current, owner, actor);
      this.logger.log({ event: 'checkout_recovered_forward', attemptId, requestId });
      await this.recordRecovered(attempt, 'COMPLETED', actor);
      return 'COMPLETED';
    } catch (error: unknown) {
      if (error instanceof LeaseLostError) return 'SKIPPED';
      const code = recoveryErrorCode(error);
      const delayMs = await this.scheduleRetry(attempt, owner, code);
      const log = {
        event: 'checkout_recovery_deferred',
        attemptId,
        requestId,
        state: attempt.state,
        recoveryAttempts: attempt.recoveryAttempts,
        errorCode: code,
        errorType: error instanceof Error ? error.name : 'UnknownError',
        retryInMs: delayMs,
      };
      if (code === 'INVENTORY_UNAVAILABLE') this.logger.warn(log);
      else this.logger.error(log);
      return 'DEFERRED';
    }
  }

  async staleAttempts(limit: number): Promise<string[]> {
    const now = new Date();
    const rows = await this.prisma.checkoutAttempt.findMany({
      where: {
        state: { in: [...INFLIGHT_STATES] },
        AND: [
          { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
          { OR: [{ nextRecoveryAt: null }, { nextRecoveryAt: { lte: now } }] },
        ],
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /**
   * Declara atascadas las sagas en curso que superan la antigüedad o los reintentos permitidos y
   * emite la alerta una sola vez por saga (log de error + evento técnico en la outbox). Considera
   * todas las sagas en curso, incluso con arrendamiento vigente o en espera de backoff.
   */
  async detectStuck(): Promise<string[]> {
    const now = new Date();
    const candidates = await this.prisma.checkoutAttempt.findMany({
      where: {
        state: { in: [...INFLIGHT_STATES] },
        stuckSince: null,
        OR: [
          { createdAt: { lt: new Date(now.getTime() - commerceConfig.stuckAgeMs) } },
          { recoveryAttempts: { gte: commerceConfig.stuckAttempts } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    const flagged: string[] = [];
    for (const candidate of candidates) {
      const marked = await this.prisma.checkoutAttempt.updateMany({
        where: { id: candidate.id, stuckSince: null, state: { in: [...INFLIGHT_STATES] } },
        data: { stuckSince: now },
      });
      if (marked.count !== 1) continue;
      flagged.push(candidate.id);
      const metadata = {
        state: candidate.state,
        // CONFIRMED: Catalog ya confirmó la reserva (punto de no retorno); nunca se libera sola.
        pointOfNoReturn: candidate.state === 'CONFIRMED' ? 'yes' : 'unknown',
        recoveryAttempts: candidate.recoveryAttempts,
        ageSeconds: Math.round((now.getTime() - candidate.createdAt.getTime()) / 1000),
        lastRecoveryError: candidate.lastRecoveryError ?? 'NONE',
      };
      this.logger.error({ event: 'checkout_saga_stuck', attemptId: candidate.id, ...metadata });
      await this.outbox.record(
        { userId: candidate.userId, role: 'CLIENTE', requestId: randomUUID() },
        {
          eventType: 'CHECKOUT_SAGA_STUCK',
          result: 'FALLO',
          resourceType: 'checkout',
          resourceId: candidate.id,
          metadata,
        },
      );
    }
    return flagged;
  }

  /** Indicadores de salud de la saga, calculados desde la base de datos (fuente de verdad). */
  async sagaMetrics(): Promise<SagaMetrics> {
    const now = Date.now();
    const [grouped, stuck, oldest, maxAttempts, nextDue] = await Promise.all([
      this.prisma.checkoutAttempt.groupBy({
        by: ['state'],
        where: { state: { in: [...INFLIGHT_STATES] } },
        _count: { _all: true },
      }),
      this.prisma.checkoutAttempt.count({
        where: { state: { in: [...INFLIGHT_STATES] }, stuckSince: { not: null } },
      }),
      this.prisma.checkoutAttempt.findFirst({
        where: { state: { in: [...INFLIGHT_STATES] } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      this.prisma.checkoutAttempt.aggregate({
        where: { state: { in: [...INFLIGHT_STATES] } },
        _max: { recoveryAttempts: true },
      }),
      this.prisma.checkoutAttempt.findFirst({
        where: { state: { in: [...INFLIGHT_STATES] }, nextRecoveryAt: { not: null } },
        orderBy: { nextRecoveryAt: 'asc' },
        select: { nextRecoveryAt: true },
      }),
    ]);
    const inflight = { STARTED: 0, RESERVED: 0, CONFIRMED: 0 };
    for (const row of grouped) {
      if (row.state in inflight) inflight[row.state as keyof typeof inflight] = row._count._all;
    }
    return {
      inflight,
      inflightTotal: inflight.STARTED + inflight.RESERVED + inflight.CONFIRMED,
      stuck,
      oldestInflightAgeSeconds: oldest ? Math.round((now - oldest.createdAt.getTime()) / 1000) : 0,
      maxRecoveryAttempts: maxAttempts._max.recoveryAttempts ?? 0,
      nextRecoveryInSeconds: nextDue?.nextRecoveryAt
        ? Math.max(0, Math.round((nextDue.nextRecoveryAt.getTime() - now) / 1000))
        : null,
    };
  }

  /** Backoff exponencial acotado: base × 2^(intentos−1), con tope. Devuelve la espera aplicada. */
  private async scheduleRetry(
    attempt: CheckoutAttempt,
    owner: string,
    code: RecoveryErrorCode,
  ): Promise<number> {
    const delayMs = recoveryBackoffMs(attempt.recoveryAttempts);
    await this.prisma.checkoutAttempt.updateMany({
      where: { id: attempt.id, leaseOwner: owner, state: { in: [...INFLIGHT_STATES] } },
      data: {
        leaseUntil: new Date(),
        nextRecoveryAt: new Date(Date.now() + delayMs),
        lastRecoveryError: code,
      },
    });
    return delayMs;
  }

  private async recordRecovered(
    attempt: CheckoutAttempt,
    outcome: 'COMPLETED' | 'ABORTED',
    actor: AuditActor,
  ): Promise<void> {
    if (!attempt.stuckSince) return;
    const metadata = {
      outcome,
      recoveryAttempts: attempt.recoveryAttempts,
      stuckSeconds: Math.round((Date.now() - attempt.stuckSince.getTime()) / 1000),
    };
    this.logger.log({ event: 'checkout_saga_recovered', attemptId: attempt.id, ...metadata });
    await this.outbox.record(actor, {
      eventType: 'CHECKOUT_SAGA_RECOVERED',
      result: 'EXITO',
      resourceType: 'checkout',
      resourceId: attempt.id,
      metadata,
    });
  }

  private findByKey(userId: string, key: string): Promise<CheckoutAttempt | null> {
    return this.prisma.checkoutAttempt.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey: key } },
    });
  }

  /** C1: crea (o reinicia tras un aborto técnico) el intento con el carrito bloqueado. */
  private async begin(
    actor: AuditActor,
    key: string,
    dto: PlaceOrderDto,
    hash: string,
    restart: boolean,
  ): Promise<
    | { kind: 'started'; attempt: CheckoutAttempt; owner: string }
    | { kind: 'replay'; attempt: CheckoutAttempt }
  > {
    const owner = randomUUID();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const cart = await tx.cart.findFirst({
          where: { userId: actor.userId, status: 'ACTIVO' },
          select: { id: true },
        });
        if (!cart) throw cartEmpty();
        await tx.$executeRaw`SELECT 1 FROM "commerce"."carts" WHERE "id" = ${cart.id}::uuid FOR UPDATE`;
        const raced = await tx.checkoutAttempt.findUnique({
          where: { userId_idempotencyKey: { userId: actor.userId, idempotencyKey: key } },
        });
        if (raced && !(restart && raced.state === 'ABORTED')) {
          return { kind: 'replay' as const, attempt: raced };
        }
        const items = await tx.cartItem.findMany({
          where: { cartId: cart.id },
          orderBy: { productId: 'asc' },
        });
        if (items.length === 0) throw cartEmpty();
        const inflight = await tx.checkoutAttempt.count({
          where: { cartId: cart.id, state: { in: [...INFLIGHT_STATES] } },
        });
        if (inflight > 0) throw inProgress();
        if (!raced) {
          const recent = await tx.checkoutAttempt.count({
            where: { userId: actor.userId, createdAt: { gt: new Date(Date.now() - 60_000) } },
          });
          if (recent >= commerceConfig.checkoutAttemptsPerMinute) {
            throw new HttpException(
              {
                code: 'CHECKOUT_RATE_LIMITED',
                message: 'Demasiados intentos de confirmación; espera un minuto',
              },
              HttpStatus.TOO_MANY_REQUESTS,
            );
          }
        }
        const data = {
          cartId: cart.id,
          requestHash: hash,
          cartFingerprint: dto.cartFingerprint,
          state: 'STARTED' as const,
          reservationId: randomUUID(),
          leaseOwner: owner,
          leaseUntil: new Date(Date.now() + commerceConfig.checkoutLeaseMs),
          paymentResult: dto.simulatedPaymentResult,
          lines: items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
          pricedLines: Prisma.DbNull,
          shipping: { ...shippingFrom(dto) },
          failureCode: null,
          failureDetails: Prisma.DbNull,
        };
        const attempt = raced
          ? await tx.checkoutAttempt.update({ where: { id: raced.id }, data })
          : await tx.checkoutAttempt.create({
              data: {
                ...data,
                userId: actor.userId,
                idempotencyKey: key,
                expiresAt: new Date(Date.now() + commerceConfig.idempotencyTtlMs),
              },
            });
        return { kind: 'started' as const, attempt, owner };
      });
    } catch (error: unknown) {
      if (!isUniqueConflict(error)) throw error;
      const attempt = await this.findByKey(actor.userId, key);
      if (attempt) return { kind: 'replay', attempt };
      throw inProgress();
    }
  }

  private async replay(
    attempt: CheckoutAttempt,
    hash: string,
    actor: AuditActor,
    dto: PlaceOrderDto,
    depth: number,
  ): Promise<PlaceOutcome> {
    if (attempt.requestHash !== hash) {
      throw new UnprocessableEntityException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'La clave de idempotencia ya se usó con otro contenido',
      });
    }
    if (attempt.expiresAt.getTime() <= Date.now()) {
      throw new UnprocessableEntityException({
        code: 'IDEMPOTENCY_KEY_EXPIRED',
        message: 'La clave de idempotencia venció; genera una nueva confirmación',
      });
    }
    if (depth > 2) throw inProgress();
    if (attempt.state === 'COMPLETED') {
      return { status: 200, order: await this.orderOf(attempt) };
    }
    if (attempt.state === 'FAILED' || attempt.state === 'REJECTED') {
      throw this.storedFailure(attempt);
    }
    if (attempt.state === 'ABORTED') {
      // Un aborto técnico no tuvo efectos de negocio: la misma clave reanuda la intención.
      const restarted = await this.begin(actor, attempt.idempotencyKey, dto, hash, true);
      if (restarted.kind === 'replay') {
        return this.replay(restarted.attempt, hash, actor, dto, depth + 1);
      }
      return this.drive(restarted.attempt, restarted.owner, actor);
    }
    // En curso: una petición duplicada concurrente espera el resultado del primer envío (PT14).
    const settled = await this.awaitSettled(attempt.id);
    if (!INFLIGHT_STATES.includes(settled.state)) {
      return this.replay(settled, hash, actor, dto, depth + 1);
    }
    if (settled.leaseUntil && settled.leaseUntil.getTime() > Date.now()) throw inProgress();
    await this.reconcile(settled.id, actor.requestId);
    const reconciled = await this.prisma.checkoutAttempt.findUniqueOrThrow({
      where: { id: settled.id },
    });
    if (INFLIGHT_STATES.includes(reconciled.state)) throw pending();
    return this.replay(reconciled, hash, actor, dto, depth + 1);
  }

  private async awaitSettled(attemptId: string): Promise<CheckoutAttempt> {
    const deadline = Date.now() + commerceConfig.duplicateWaitMs;
    for (;;) {
      const attempt = await this.prisma.checkoutAttempt.findUniqueOrThrow({
        where: { id: attemptId },
      });
      const leaseActive = attempt.leaseUntil !== null && attempt.leaseUntil.getTime() > Date.now();
      if (!INFLIGHT_STATES.includes(attempt.state) || !leaseActive || Date.now() >= deadline) {
        return attempt;
      }
      await delay(100);
    }
  }

  private async drive(
    initial: CheckoutAttempt,
    owner: string,
    actor: AuditActor,
  ): Promise<PlaceOutcome> {
    let attempt = initial;
    try {
      for (;;) {
        if (attempt.state === 'STARTED')
          attempt = await this.validateAndReserve(attempt, owner, actor);
        else if (attempt.state === 'RESERVED') attempt = await this.confirm(attempt, owner, actor);
        else if (attempt.state === 'CONFIRMED') {
          await this.complete(attempt, owner, actor);
          const completed = await this.prisma.checkoutAttempt.findUniqueOrThrow({
            where: { id: attempt.id },
          });
          return { status: 201, order: await this.orderOf(completed) };
        } else {
          throw this.storedFailure(attempt);
        }
      }
    } catch (error: unknown) {
      if (error instanceof LeaseLostError) throw pending();
      if (error instanceof InventoryUnavailableError) {
        await this.releaseLease(attempt.id, owner);
        throw pending();
      }
      if (!(error instanceof HttpException)) await this.releaseLease(attempt.id, owner);
      throw error;
    }
  }

  /** Validación previa (precios, stock, huella A4, pago simulado) y reserva R. */
  private async validateAndReserve(
    attempt: CheckoutAttempt,
    owner: string,
    actor: AuditActor,
  ): Promise<CheckoutAttempt> {
    const lines = attemptLines(attempt);
    let snapshots;
    try {
      snapshots = await this.catalog.snapshot(
        lines.map((line) => line.productId),
        actor.requestId,
      );
    } catch (error: unknown) {
      // Todavía no se envió ninguna reserva: aborto técnico sin efectos de negocio.
      await this.terminate(attempt, owner, 'ABORTED', 'CATALOG_UNAVAILABLE', undefined);
      throw error;
    }
    const priced = priceSummary(lines, snapshots);
    if (priced.conflicts.length > 0) {
      return this.failStock(attempt, owner, actor, priced.conflicts);
    }
    if (priced.fingerprint !== attempt.cartFingerprint) {
      await this.terminate(attempt, owner, 'FAILED', 'CHECKOUT_SUMMARY_CHANGED', undefined);
      throw this.summaryChanged();
    }
    if (attempt.paymentResult === 'RECHAZADO') {
      // CA-M04-02: rechazo sin reservar ni descontar stock; el carrito queda intacto.
      await this.terminate(
        attempt,
        owner,
        'REJECTED',
        'PAYMENT_SIMULATED_REJECTED',
        undefined,
        {
          eventType: 'PAYMENT_SIMULATED_REJECTED',
          result: 'FALLO',
          resourceType: 'checkout',
          resourceId: attempt.id,
          metadata: { itemCount: lines.reduce((sum, line) => sum + line.quantity, 0) },
        },
        actor,
      );
      throw this.rejected();
    }
    let result;
    try {
      result = await this.inventory.reserve(
        attempt.reservationId,
        priced.lines.map((line) => ({
          productId: line.productId,
          quantity: line.quantity,
          expectedUnitPrice: line.unitPrice,
        })),
        actor.requestId,
      );
    } catch (error: unknown) {
      if (error instanceof InventoryUnavailableError) await this.compensate(attempt, owner, actor);
      throw error;
    }
    if (result.kind === 'conflict') {
      if (result.conflicts.every((conflict) => conflict.reason === 'PRICE_CHANGED')) {
        await this.terminate(attempt, owner, 'FAILED', 'CHECKOUT_SUMMARY_CHANGED', undefined);
        throw this.summaryChanged();
      }
      return this.failStock(attempt, owner, actor, result.conflicts);
    }
    if (result.kind === 'released') throw new LeaseLostError();
    if (!sameLines(lines, result.reservation.lines)) throw new ReservationMismatchError();
    return this.transition(attempt, owner, 'RESERVED', {});
  }

  /** K: confirmación en Catalog. Si la reserva venció, Catalog ya la compensó. */
  private async confirm(
    attempt: CheckoutAttempt,
    owner: string,
    actor: AuditActor,
  ): Promise<CheckoutAttempt> {
    const result = await this.inventory.confirm(attempt.reservationId, actor.requestId);
    if (result.kind === 'released') {
      await this.terminate(attempt, owner, 'ABORTED', 'RESERVATION_EXPIRED', undefined);
      throw new ConflictException({
        code: 'CHECKOUT_EXPIRED',
        message: 'La reserva de inventario venció; confirma de nuevo',
      });
    }
    if (!sameLines(attemptLines(attempt), result.reservation.lines)) {
      throw new ReservationMismatchError();
    }
    return this.transition(attempt, owner, 'CONFIRMED', {
      pricedLines: result.reservation.lines.map((line) => ({ ...line })),
    });
  }

  /** C3: transacción local que crea el pedido PAGADO y convierte el carrito (RN-16 adaptada). */
  private async complete(
    attempt: CheckoutAttempt,
    owner: string,
    actor: AuditActor,
  ): Promise<void> {
    const priced = pricedLines(attempt);
    const shipping = shippingOf(attempt);
    const { total, items } = orderTotals(priced);
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.checkoutAttempt.updateMany({
        where: { id: attempt.id, state: 'CONFIRMED', leaseOwner: owner },
        data: { leaseUntil: new Date(Date.now() + commerceConfig.checkoutLeaseMs) },
      });
      if (claimed.count !== 1) throw new LeaseLostError();
      const order = await tx.order.create({
        data: {
          userId: attempt.userId,
          idempotencyKey: attempt.idempotencyKey,
          checkoutAttemptId: attempt.id,
          status: 'PAGADO',
          total: total.toFixed(2),
          shippingName: shipping.recipientName,
          shippingPhone: shipping.phone,
          shippingDepartment: shipping.department,
          shippingMunicipality: shipping.municipality,
          shippingAddress: shipping.address,
          shippingReferences: shipping.references ?? null,
          paymentReference: paymentReference(randomBytes(8).toString('hex')),
          paidAt: new Date(),
          items: {
            create: items.map(({ line, lineTotal }) => ({
              productId: line.productId,
              productNameSnapshot: line.name,
              unitPrice: line.unitPrice,
              quantity: line.quantity,
              lineTotal: lineTotal.toFixed(2),
            })),
          },
        },
      });
      await tx.checkoutAttempt.update({
        where: { id: attempt.id },
        data: {
          state: 'COMPLETED',
          orderId: order.id,
          shipping: Prisma.DbNull,
          leaseOwner: null,
          leaseUntil: null,
        },
      });
      await tx.cart.updateMany({
        where: { id: attempt.cartId, status: 'ACTIVO' },
        data: { status: 'CONVERTIDO' },
      });
      await this.outbox.record(
        actor,
        {
          eventType: 'ORDER_CREATED',
          result: 'EXITO',
          resourceType: 'order',
          resourceId: order.id,
          metadata: {
            orderNumber: order.orderNumber,
            total: total.toFixed(2),
            itemCount: priced.reduce((sum, line) => sum + line.quantity, 0),
            checkoutAttemptId: attempt.id,
          },
        },
        tx,
      );
    });
  }

  /** Compensación inmediata tras un fallo ambiguo de la reserva (timeout o caída de Catalog). */
  private async compensate(
    attempt: CheckoutAttempt,
    owner: string,
    actor: AuditActor,
  ): Promise<void> {
    try {
      const state = await this.inventory.release(attempt.reservationId, actor.requestId);
      if (state.status === 'RELEASED') {
        await this.terminate(attempt, owner, 'ABORTED', 'CATALOG_UNAVAILABLE', undefined);
        return;
      }
    } catch {
      // Catalog sigue sin responder: el reconciliador o un reintento terminarán la compensación.
    }
    await this.releaseLease(attempt.id, owner);
  }

  private async failStock(
    attempt: CheckoutAttempt,
    owner: string,
    actor: AuditActor,
    conflicts: readonly CheckoutConflictLine[],
  ): Promise<never> {
    await this.terminate(
      attempt,
      owner,
      'FAILED',
      'CHECKOUT_STOCK_CONFLICT',
      conflicts,
      {
        eventType: 'CHECKOUT_STOCK_CONFLICT',
        result: 'FALLO',
        resourceType: 'checkout',
        resourceId: attempt.id,
        metadata: {
          conflictCount: conflicts.length,
          productIds: conflicts.map((conflict) => conflict.productId),
        },
      },
      actor,
    );
    throw this.stockConflict(conflicts);
  }

  private async transition(
    attempt: CheckoutAttempt,
    owner: string,
    to: CheckoutState,
    data: { pricedLines?: Prisma.InputJsonValue },
  ): Promise<CheckoutAttempt> {
    const changed = await this.prisma.checkoutAttempt.updateMany({
      where: { id: attempt.id, state: attempt.state, leaseOwner: owner },
      data: {
        state: to,
        leaseUntil: new Date(Date.now() + commerceConfig.checkoutLeaseMs),
        ...data,
      },
    });
    if (changed.count !== 1) throw new LeaseLostError();
    return this.prisma.checkoutAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
  }

  private async terminate(
    attempt: CheckoutAttempt,
    owner: string,
    state: 'FAILED' | 'REJECTED' | 'ABORTED',
    failureCode: string,
    conflicts: readonly CheckoutConflictLine[] | undefined,
    event?: Parameters<OutboxService['record']>[1],
    actor?: AuditActor,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.checkoutAttempt.updateMany({
        where: { id: attempt.id, state: { in: [...INFLIGHT_STATES] }, leaseOwner: owner },
        data: {
          state,
          failureCode,
          failureDetails: conflicts
            ? { conflicts: conflicts.map((conflict) => ({ ...conflict })) }
            : Prisma.DbNull,
          shipping: Prisma.DbNull,
          leaseOwner: null,
          leaseUntil: null,
        },
      });
      if (changed.count !== 1) throw new LeaseLostError();
      if (event) {
        await this.outbox.record(
          actor ?? { userId: attempt.userId, role: 'CLIENTE', requestId: randomUUID() },
          event,
          tx,
        );
      }
    });
  }

  private async releaseLease(attemptId: string, owner: string): Promise<void> {
    await this.prisma.checkoutAttempt.updateMany({
      where: { id: attemptId, leaseOwner: owner, state: { in: [...INFLIGHT_STATES] } },
      data: { leaseUntil: new Date() },
    });
  }

  private storedFailure(attempt: CheckoutAttempt): HttpException {
    if (attempt.state === 'REJECTED') return this.rejected();
    if (attempt.failureCode === 'CHECKOUT_STOCK_CONFLICT') {
      const details = attempt.failureDetails as { conflicts?: CheckoutConflictLine[] } | null;
      return this.stockConflict(details?.conflicts ?? []);
    }
    if (attempt.failureCode === 'CHECKOUT_SUMMARY_CHANGED') return this.summaryChanged();
    return inProgress();
  }

  private stockConflict(conflicts: readonly CheckoutConflictLine[]): ConflictException {
    return new ConflictException({
      code: 'CHECKOUT_STOCK_CONFLICT',
      message: 'Stock insuficiente para una o más líneas',
      details: { conflicts },
    });
  }

  private summaryChanged(): ConflictException {
    return new ConflictException({
      code: 'CHECKOUT_SUMMARY_CHANGED',
      message: 'El resumen cambió; revisa el nuevo total y confirma de nuevo',
    });
  }

  private rejected(): UnprocessableEntityException {
    return new UnprocessableEntityException({
      code: 'PAYMENT_SIMULATED_REJECTED',
      message: 'El pago simulado fue rechazado',
    });
  }

  private async orderOf(attempt: CheckoutAttempt): Promise<OrderConfirmation> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { checkoutAttemptId: attempt.id },
      include: { items: { orderBy: { productId: 'asc' } } },
    });
    return this.present(order);
  }

  private present(order: OrderWithItems): OrderConfirmation {
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      total: order.total.toFixed(2),
      currency: 'GTQ',
      itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
      paymentReference: order.paymentReference,
      createdAt: order.createdAt.toISOString(),
      items: order.items.map((item) => ({
        productId: item.productId,
        name: item.productNameSnapshot,
        quantity: item.quantity,
        unitPrice: item.unitPrice.toFixed(2),
        lineTotal: item.lineTotal.toFixed(2),
      })),
      shipping: {
        recipientName: order.shippingName,
        phone: order.shippingPhone,
        department: order.shippingDepartment,
        municipality: order.shippingMunicipality,
        address: order.shippingAddress,
        ...(order.shippingReferences ? { references: order.shippingReferences } : {}),
      },
    };
  }
}
