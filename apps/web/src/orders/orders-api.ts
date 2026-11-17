import type {
  OrderDetail,
  OrderHistoryPage,
  OrderStatus,
  OrderSummary,
  OrderTimelineEntry,
} from '@spectra/contracts';
import { AuthApiError } from '../auth/auth-api.js';
import { CheckoutApiError, decodeOrder, execute } from '../checkout/checkout-api.js';

const MONEY = /^\d{1,10}\.\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: readonly OrderStatus[] = [
  'PAGADO',
  'EN_PREPARACION',
  'ENVIADO',
  'ENTREGADO',
  'CANCELADO',
];

export const SESSION_EXPIRED = 'SESSION_EXPIRED';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new CheckoutApiError('La respuesta del servidor no es válida', 0, undefined);
}

function isStatus(value: unknown): value is OrderStatus {
  return STATUSES.includes(value as OrderStatus);
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function decodeTimeline(value: unknown): OrderTimelineEntry[] {
  if (!Array.isArray(value) || value.length === 0) invalid();
  return value.map((entry: unknown) => {
    if (!isRecord(entry) || !isStatus(entry.status) || !isInstant(entry.at)) invalid();
    return { status: entry.status, at: entry.at };
  });
}

/** Detalle M05: la confirmación M04 validada más estado vigente y línea de tiempo. Falla cerrado. */
export function decodeOrderDetail(value: unknown): OrderDetail {
  const order = decodeOrder(value);
  if (!isRecord(value) || !isInstant(value.statusChangedAt)) invalid();
  return {
    ...order,
    statusChangedAt: value.statusChangedAt,
    timeline: decodeTimeline(value.timeline),
  };
}

function decodeSummary(value: unknown): OrderSummary {
  if (!isRecord(value)) invalid();
  const { id, orderNumber, status, statusChangedAt, createdAt, itemCount, total, currency } = value;
  if (
    typeof id !== 'string' ||
    !UUID.test(id) ||
    typeof orderNumber !== 'string' ||
    !/^SP-\d+$/.test(orderNumber) ||
    !isStatus(status) ||
    !isInstant(statusChangedAt) ||
    !isInstant(createdAt) ||
    !isCount(itemCount) ||
    typeof total !== 'string' ||
    !MONEY.test(total) ||
    currency !== 'GTQ'
  ) {
    invalid();
  }
  return { id, orderNumber, status, statusChangedAt, createdAt, itemCount, total, currency };
}

export function decodeHistory(value: unknown): OrderHistoryPage {
  if (!isRecord(value) || !Array.isArray(value.items) || !isRecord(value.meta)) invalid();
  const { page, pageSize, totalItems, totalPages } = value.meta;
  if (
    !isCount(page) ||
    page < 1 ||
    !isCount(pageSize) ||
    !isCount(totalItems) ||
    !isCount(totalPages) ||
    value.items.length > pageSize
  ) {
    invalid();
  }
  return {
    items: value.items.map(decodeSummary),
    meta: { page, pageSize, totalItems, totalPages },
  };
}

/** Una sesión que no pudo renovarse se informa como expirada para redirigir al login (A3). */
async function load(path: string, signal?: AbortSignal): Promise<unknown> {
  try {
    const { payload } = await execute(path, signal ? { signal } : undefined);
    return payload;
  } catch (error: unknown) {
    if (
      error instanceof AuthApiError ||
      (error instanceof CheckoutApiError && error.status === 401)
    ) {
      throw new CheckoutApiError('Tu sesión expiró. Inicia sesión de nuevo.', 401, SESSION_EXPIRED);
    }
    throw error;
  }
}

/** RF-026: solo se envía el número de página; tamaño y propietario los decide el servidor. */
export async function getOrderHistory(
  page: number,
  signal?: AbortSignal,
): Promise<OrderHistoryPage> {
  const safePage = Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1;
  return decodeHistory(await load(`/orders?page=${safePage}`, signal));
}

/** RF-027/RF-028: el identificador de la ruta es el UUID; el número SP-… es solo informativo. */
export async function getOrderDetail(orderId: string, signal?: AbortSignal): Promise<OrderDetail> {
  if (!UUID.test(orderId)) {
    throw new CheckoutApiError('Pedido no encontrado', 404, 'ORDER_NOT_FOUND');
  }
  return decodeOrderDetail(await load(`/orders/${encodeURIComponent(orderId)}`, signal));
}

/** M06 mínimo: listado de solo lectura de todos los pedidos (el servidor exige ADMIN). */
export async function getAdminOrders(
  page: number,
  signal?: AbortSignal,
): Promise<OrderHistoryPage> {
  const safePage = Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1;
  return decodeHistory(await load(`/admin/orders?page=${safePage}`, signal));
}
