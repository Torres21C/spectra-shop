import type {
  OrderConfirmation,
  OrderDetail,
  OrderStatus,
  OrderSummary,
  OrderTimelineEntry,
} from '@spectra/contracts';
import type { Prisma } from '../generated/commerce-client/index.js';

/** D-M05-04: tamaño de página fijo, controlado exclusivamente por el servidor. */
export const ORDER_HISTORY_PAGE_SIZE = 10;

/** Fechas por estado (D-M05-01). `paidAt` siempre existe: todo pedido nace PAGADO en M04. */
export interface OrderTimelineColumns {
  readonly status: OrderStatus;
  readonly paidAt: Date;
  readonly preparingAt: Date | null;
  readonly shippedAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly cancelledAt: Date | null;
}

/** Error interno: la fila viola la coherencia que garantiza `orders_timeline_status_check`. */
export class InconsistentOrderTimelineError extends Error {
  constructor() {
    super('order timeline inconsistent with status');
    this.name = 'InconsistentOrderTimelineError';
  }
}

/**
 * Línea de tiempo en el orden de RN-24. CANCELADO va al final porque `cancelled_at` es posterior a
 * cualquier otro hito (restricción `orders_timeline_chronology_check`).
 */
export function orderTimeline(order: OrderTimelineColumns): OrderTimelineEntry[] {
  const milestones: [OrderStatus, Date | null][] = [
    ['PAGADO', order.paidAt],
    ['EN_PREPARACION', order.preparingAt],
    ['ENVIADO', order.shippedAt],
    ['ENTREGADO', order.deliveredAt],
    ['CANCELADO', order.cancelledAt],
  ];
  return milestones.flatMap(([status, at]) => (at ? [{ status, at: at.toISOString() }] : []));
}

/**
 * Fecha del estado vigente = último cambio registrado (CA-M05-04). Falla cerrado si la fila es
 * incoherente en lugar de mostrar una fecha que no corresponde al estado.
 */
export function statusChangedAt(order: OrderTimelineColumns): string {
  const byStatus: Record<OrderStatus, Date | null> = {
    PAGADO: order.paidAt,
    EN_PREPARACION: order.preparingAt,
    ENVIADO: order.shippedAt,
    ENTREGADO: order.deliveredAt,
    CANCELADO: order.cancelledAt,
  };
  const at = byStatus[order.status];
  if (!at) throw new InconsistentOrderTimelineError();
  return at.toISOString();
}

export type OrderWithItems = Prisma.OrderGetPayload<{ include: { items: true } }>;

/** Representación de M04 (confirmación); se conserva intacta para no romper P06. */
export function presentConfirmation(order: OrderWithItems): OrderConfirmation {
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

/** Detalle M05: confirmación M04 + estado vigente con su fecha + línea de tiempo. */
export function presentDetail(order: OrderWithItems): OrderDetail {
  return {
    ...presentConfirmation(order),
    statusChangedAt: statusChangedAt(order),
    timeline: orderTimeline(order),
  };
}

export type OrderSummaryRow = Prisma.OrderGetPayload<{
  select: typeof ORDER_SUMMARY_SELECT;
}>;

/** Lista blanca de columnas del historial: sin datos de entrega ni referencia de pago. */
export const ORDER_SUMMARY_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  total: true,
  createdAt: true,
  paidAt: true,
  preparingAt: true,
  shippedAt: true,
  deliveredAt: true,
  cancelledAt: true,
  items: { select: { quantity: true } },
} as const satisfies Prisma.OrderSelect;

export function presentSummary(order: OrderSummaryRow): OrderSummary {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    statusChangedAt: statusChangedAt(order),
    createdAt: order.createdAt.toISOString(),
    itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
    total: order.total.toFixed(2),
    currency: 'GTQ',
  };
}

export function totalPages(totalItems: number): number {
  return Math.ceil(totalItems / ORDER_HISTORY_PAGE_SIZE);
}
