import { randomBytes, randomUUID } from 'node:crypto';
import type { OrderStatus } from '@spectra/contracts';
import type { PrismaClient } from '../generated/commerce-client/index.js';

export interface FixtureLine {
  readonly productId: string;
  readonly name: string;
  readonly unitPrice: string;
  readonly quantity: number;
}

export interface FixtureOrder {
  readonly id: string;
  readonly orderNumber: string;
}

const DEFAULT_LINE: FixtureLine = {
  productId: '20000000-0000-4000-8000-000000000005',
  name: 'Mouse sintético de historial',
  unitPrice: '150.00',
  quantity: 1,
};

/**
 * Inserta un pedido PAGADO con la misma forma que deja la saga M04 (carrito CONVERTIDO, intento
 * COMPLETED y pedido con precios congelados) sin pasar por Catalog. Sirve para preparar historiales
 * grandes (paginación) o contenidos hostiles (XSS) sin consumir stock real. Solo para pruebas.
 */
export async function seedOrder(
  prisma: PrismaClient,
  userId: string,
  options: {
    createdAt?: Date;
    lines?: readonly FixtureLine[];
    shippingReferences?: string;
    shippingAddress?: string;
  } = {},
): Promise<FixtureOrder> {
  const createdAt = options.createdAt ?? new Date();
  const lines = options.lines ?? [DEFAULT_LINE];
  const orderId = randomUUID();
  const cart = await prisma.cart.create({ data: { userId, status: 'CONVERTIDO' } });
  const attempt = await prisma.checkoutAttempt.create({
    data: {
      userId,
      cartId: cart.id,
      idempotencyKey: randomUUID(),
      requestHash: randomBytes(32).toString('hex'),
      cartFingerprint: randomBytes(32).toString('hex'),
      state: 'COMPLETED',
      reservationId: randomUUID(),
      paymentResult: 'APROBADO',
      lines: lines.map(({ productId, quantity, unitPrice }) => ({
        productId,
        quantity,
        expectedUnitPrice: unitPrice,
      })),
      orderId,
      expiresAt: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000),
      createdAt,
    },
  });
  const total = lines.reduce((sum, line) => sum + Number(line.unitPrice) * line.quantity, 0);
  const order = await prisma.order.create({
    data: {
      id: orderId,
      userId,
      idempotencyKey: attempt.idempotencyKey,
      checkoutAttemptId: attempt.id,
      status: 'PAGADO',
      total: total.toFixed(2),
      shippingName: 'Cliente Sintético',
      shippingPhone: '5555-0101',
      shippingDepartment: 'Guatemala',
      shippingMunicipality: 'Mixco',
      shippingAddress: options.shippingAddress ?? 'Calle ficticia 1-23, zona 1',
      shippingReferences: options.shippingReferences ?? null,
      paymentReference: `SIM-${randomBytes(8).toString('hex').toUpperCase()}`,
      paidAt: createdAt,
      createdAt,
      items: {
        create: lines.map((line) => ({
          productId: line.productId,
          productNameSnapshot: line.name,
          unitPrice: line.unitPrice,
          quantity: line.quantity,
          lineTotal: (Number(line.unitPrice) * line.quantity).toFixed(2),
        })),
      },
    },
  });
  return { id: order.id, orderNumber: order.orderNumber };
}

const COLUMN_BY_STATUS = {
  EN_PREPARACION: 'preparingAt',
  ENVIADO: 'shippedAt',
  ENTREGADO: 'deliveredAt',
  CANCELADO: 'cancelledAt',
} as const;

/**
 * D-M05-02: simula el cambio de estado que registrará el administrador en M06 (estado + fecha del
 * estado en una sola sentencia). La validez de la transición la garantizan las restricciones de BD.
 */
export async function simulateAdminTransition(
  prisma: PrismaClient,
  orderId: string,
  status: Exclude<OrderStatus, 'PAGADO'>,
  at: Date,
): Promise<void> {
  await prisma.order.update({
    where: { id: orderId },
    data: { status, [COLUMN_BY_STATUS[status]]: at },
  });
}
