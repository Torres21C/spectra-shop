import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CheckoutConflictLine,
  StockReservation,
  StockReservationState,
} from '@spectra/contracts';
import { PrismaService } from '../database/prisma.service.js';
import { inventoryConfig } from './inventory.config.js';
import type { CreateReservationDto, ReservationLineDto } from './inventory.dto.js';

type Tx = Prisma.TransactionClient;

type ReservationWithLines = Prisma.StockReservationGetPayload<{ include: { lines: true } }>;

class ReservationConflict extends Error {
  constructor(readonly conflicts: CheckoutConflictLine[]) {
    super('reservation conflict');
  }
}

export function reservationRequestHash(lines: readonly ReservationLineDto[]): string {
  const canonical = [...lines]
    .sort((left, right) => left.productId.localeCompare(right.productId))
    .map((line) => `${line.productId}:${line.quantity}:${line.expectedUnitPrice}`)
    .join('|');
  return createHash('sha256').update(`v1|${canonical}`, 'utf8').digest('hex');
}

/**
 * Inventario de M04. Cada operación es una transacción ACID local de Catalog:
 * - reserve: todo o nada; descuenta stock con UPDATE condicional (sin sobreventa).
 * - confirm: punto de no retorno; solo acepta reservas PENDING no vencidas (reloj de BD).
 * - release: compensación idempotente; repone stock una sola vez y deja lápida si no existe.
 */
@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  async reserve(
    dto: CreateReservationDto,
  ): Promise<{ created: boolean; reservation: StockReservation }> {
    const ids = new Set(dto.lines.map((line) => line.productId));
    if (ids.size !== dto.lines.length) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Líneas duplicadas' });
    }
    const lines = [...dto.lines].sort((left, right) =>
      left.productId.localeCompare(right.productId),
    );
    const hash = reservationRequestHash(lines);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const inserted = await tx.$executeRaw`
          INSERT INTO "catalog"."stock_reservations" ("id", "caller", "status", "request_hash", "expires_at")
          VALUES (${dto.reservationId}::uuid, ${inventoryConfig.caller}, 'PENDING', ${hash},
                  now() + (${inventoryConfig.reservationTtlSeconds}::int * interval '1 second'))
          ON CONFLICT ("id") DO NOTHING`;
        if (inserted === 0) {
          return {
            created: false,
            reservation: await this.existingFor(tx, dto.reservationId, hash),
          };
        }

        const conflicts: CheckoutConflictLine[] = [];
        const reserved: { productId: string; quantity: number; unitPrice: string; name: string }[] =
          [];
        // Orden determinista por productId: evita interbloqueos entre compradores concurrentes.
        for (const line of lines) {
          const rows = await tx.$queryRaw<{ name: string; price: string }[]>`
            UPDATE "catalog"."products" AS p
               SET "stock" = p."stock" - ${line.quantity}, "updated_at" = now()
              FROM "catalog"."categories" AS c
             WHERE p."id" = ${line.productId}::uuid
               AND c."id" = p."category_id"
               AND p."is_active" AND c."is_active"
               AND p."price" = ${line.expectedUnitPrice}::numeric
               AND p."stock" >= ${line.quantity}
         RETURNING p."name", p."price"::text AS "price"`;
          const row = rows[0];
          if (row) {
            reserved.push({
              productId: line.productId,
              quantity: line.quantity,
              unitPrice: row.price,
              name: row.name,
            });
          } else {
            conflicts.push(await this.diagnose(tx, line));
          }
        }
        if (conflicts.length > 0) throw new ReservationConflict(conflicts);

        await tx.stockReservationLine.createMany({
          data: reserved.map((line) => ({
            reservationId: dto.reservationId,
            productId: line.productId,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            productName: line.name,
          })),
        });
        const reservation = await tx.stockReservation.findUniqueOrThrow({
          where: { id: dto.reservationId },
          include: { lines: { orderBy: { productId: 'asc' } } },
        });
        return { created: true, reservation: this.present(reservation) };
      });
    } catch (error: unknown) {
      if (error instanceof ReservationConflict) {
        this.logger.warn({
          event: 'stock_reservation_conflict',
          reservationId: dto.reservationId,
          conflicts: error.conflicts.length,
        });
        throw new ConflictException({ code: 'STOCK_CONFLICT', conflicts: error.conflicts });
      }
      throw error;
    }
  }

  async confirm(reservationId: string): Promise<StockReservation> {
    const confirmed = await this.prisma.$executeRaw`
      UPDATE "catalog"."stock_reservations"
         SET "status" = 'CONFIRMED', "confirmed_at" = now()
       WHERE "id" = ${reservationId}::uuid AND "status" = 'PENDING' AND "expires_at" > now()`;
    const reservation = await this.load(reservationId);
    if (!reservation) this.notFound();
    if (confirmed === 1 || reservation.status === 'CONFIRMED') return this.present(reservation);
    if (reservation.status === 'PENDING') {
      // Vencida: ya no puede confirmarse; se compensa de inmediato en lugar de esperar al barrido.
      await this.releaseExpired(reservationId);
    }
    throw new ConflictException({ code: 'RESERVATION_RELEASED' });
  }

  async release(reservationId: string, reason = 'ORCHESTRATOR'): Promise<StockReservationState> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const released = await this.releaseWhere(reservationId, reason, false);
      if (released) return this.state(reservationId);
      const reservation = await this.load(reservationId);
      if (reservation?.status === 'CONFIRMED') {
        throw new ConflictException({ code: 'RESERVATION_CONFIRMED' });
      }
      if (reservation?.status === 'RELEASED') return this.state(reservationId);
      if (!reservation) {
        // Lápida: una reserva tardía con este id quedará rechazada (petición retrasada en la red).
        await this.prisma.$executeRaw`
          INSERT INTO "catalog"."stock_reservations"
            ("id", "caller", "status", "expires_at", "released_at", "release_reason")
          VALUES (${reservationId}::uuid, ${inventoryConfig.caller}, 'RELEASED', now(), now(), ${reason})
          ON CONFLICT ("id") DO NOTHING`;
      }
    }
    return this.state(reservationId);
  }

  async state(reservationId: string): Promise<StockReservationState> {
    const rows = await this.prisma.$queryRaw<{ expired: boolean }[]>`
      SELECT ("expires_at" <= now()) AS "expired"
        FROM "catalog"."stock_reservations" WHERE "id" = ${reservationId}::uuid`;
    const reservation = await this.load(reservationId);
    if (!reservation) {
      return { reservationId, status: 'NOT_FOUND', expired: false, lines: [] };
    }
    const present = this.present(reservation);
    return {
      reservationId,
      status: reservation.status,
      expired: reservation.status === 'PENDING' && rows[0]?.expired === true,
      lines: present.lines,
    };
  }

  /** Libera reservas PENDING vencidas. Es seguro: una reserva vencida nunca puede confirmarse. */
  async sweepExpired(limit = inventoryConfig.sweepBatchSize): Promise<number> {
    const candidates = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "catalog"."stock_reservations"
       WHERE "status" = 'PENDING' AND "expires_at" <= now()
       ORDER BY "expires_at" ASC
       LIMIT ${limit}`;
    let released = 0;
    for (const candidate of candidates) {
      if (await this.releaseExpired(candidate.id)) released += 1;
    }
    return released;
  }

  private releaseExpired(reservationId: string): Promise<boolean> {
    return this.releaseWhere(reservationId, 'EXPIRED', true);
  }

  private releaseWhere(
    reservationId: string,
    reason: string,
    onlyExpired: boolean,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const changed = onlyExpired
        ? await tx.$executeRaw`
            UPDATE "catalog"."stock_reservations"
               SET "status" = 'RELEASED', "released_at" = now(), "release_reason" = ${reason}
             WHERE "id" = ${reservationId}::uuid AND "status" = 'PENDING' AND "expires_at" <= now()`
        : await tx.$executeRaw`
            UPDATE "catalog"."stock_reservations"
               SET "status" = 'RELEASED', "released_at" = now(), "release_reason" = ${reason}
             WHERE "id" = ${reservationId}::uuid AND "status" = 'PENDING'`;
      if (changed !== 1) return false;
      // La transición PENDING→RELEASED ocurre una sola vez, por lo que la reposición tampoco se duplica.
      await tx.$executeRaw`
        UPDATE "catalog"."products" AS p
           SET "stock" = p."stock" + l."quantity", "updated_at" = now()
          FROM "catalog"."stock_reservation_lines" AS l
         WHERE l."reservation_id" = ${reservationId}::uuid AND p."id" = l."product_id"`;
      this.logger.log({ event: 'stock_reservation_released', reservationId, reason });
      return true;
    });
  }

  private async existingFor(
    tx: Tx,
    reservationId: string,
    hash: string,
  ): Promise<StockReservation> {
    const existing = await tx.stockReservation.findUniqueOrThrow({
      where: { id: reservationId },
      include: { lines: { orderBy: { productId: 'asc' } } },
    });
    if (existing.status === 'RELEASED') {
      throw new ConflictException({ code: 'RESERVATION_RELEASED' });
    }
    if (existing.requestHash !== hash) {
      throw new ConflictException({ code: 'RESERVATION_MISMATCH' });
    }
    return this.present(existing);
  }

  private async diagnose(tx: Tx, line: ReservationLineDto): Promise<CheckoutConflictLine> {
    const product = await tx.product.findUnique({
      where: { id: line.productId },
      include: { category: { select: { isActive: true } } },
    });
    if (!product || !product.isActive || !product.category.isActive) {
      return { productId: line.productId, reason: 'INACTIVE', available: 0 };
    }
    const available = Math.min(product.stock, 10);
    if (product.price.toFixed(2) !== line.expectedUnitPrice) {
      return { productId: line.productId, reason: 'PRICE_CHANGED', available };
    }
    return { productId: line.productId, reason: 'INSUFFICIENT_STOCK', available };
  }

  private load(reservationId: string): Promise<ReservationWithLines | null> {
    return this.prisma.stockReservation.findUnique({
      where: { id: reservationId },
      include: { lines: { orderBy: { productId: 'asc' } } },
    });
  }

  private present(reservation: ReservationWithLines): StockReservation {
    return {
      reservationId: reservation.id,
      status: reservation.status,
      expiresAt: reservation.expiresAt.toISOString(),
      lines: reservation.lines.map((line) => ({
        productId: line.productId,
        name: line.productName,
        quantity: line.quantity,
        unitPrice: line.unitPrice.toFixed(2),
      })),
    };
  }

  private notFound(): never {
    throw new NotFoundException({ code: 'RESERVATION_NOT_FOUND' });
  }
}
