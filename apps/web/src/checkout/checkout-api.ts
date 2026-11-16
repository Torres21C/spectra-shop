import type {
  ApiErrorResponse,
  CheckoutConflictLine,
  CheckoutSummary,
  CheckoutSummaryLine,
  OrderConfirmation,
  OrderLine,
  PlaceOrderRequest,
  ShippingDetails,
} from '@spectra/contracts';
import { csrfToken, refreshSession } from '../auth/auth-api.js';

const COMMERCE_BASE_URL = (
  import.meta.env.VITE_COMMERCE_API_URL ?? 'http://127.0.0.1:3003'
).replace(/\/$/, '');

const MONEY = /^\d{1,10}\.\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CheckoutApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly conflicts: readonly CheckoutConflictLine[] = [],
  ) {
    super(message);
    this.name = 'CheckoutApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new CheckoutApiError('La respuesta del servidor no es válida', 0, undefined);
}

function decodeConflicts(value: unknown): CheckoutConflictLine[] {
  if (!isRecord(value) || !Array.isArray(value.conflicts)) return [];
  return value.conflicts.flatMap((entry: unknown) => {
    if (!isRecord(entry)) return [];
    const { productId, reason, available } = entry;
    return typeof productId === 'string' &&
      ['INACTIVE', 'INSUFFICIENT_STOCK', 'PRICE_CHANGED'].includes(reason as string) &&
      typeof available === 'number'
      ? [{ productId, reason: reason as CheckoutConflictLine['reason'], available }]
      : [];
  });
}

function decodeError(status: number, value: unknown): CheckoutApiError {
  if (!isRecord(value)) {
    return new CheckoutApiError('No fue posible completar la solicitud', status, undefined);
  }
  const { code, message, details } = value as Partial<ApiErrorResponse> & Record<string, unknown>;
  return new CheckoutApiError(
    typeof message === 'string' ? message : 'No fue posible completar la solicitud',
    status,
    typeof code === 'string' ? code : undefined,
    decodeConflicts(details),
  );
}

function decodeSummaryLine(value: unknown): CheckoutSummaryLine {
  if (!isRecord(value)) invalid();
  const { productId, name, quantity, unitPrice, subtotal, available, unavailableReason } = value;
  if (
    typeof productId !== 'string' ||
    typeof name !== 'string' ||
    typeof quantity !== 'number' ||
    typeof unitPrice !== 'string' ||
    !MONEY.test(unitPrice) ||
    typeof subtotal !== 'string' ||
    !MONEY.test(subtotal) ||
    typeof available !== 'boolean' ||
    (unavailableReason !== undefined &&
      !['INACTIVE', 'OUT_OF_STOCK', 'INSUFFICIENT_STOCK'].includes(unavailableReason as string))
  ) {
    invalid();
  }
  return {
    productId,
    name,
    quantity,
    unitPrice,
    subtotal,
    available,
    ...(unavailableReason
      ? {
          unavailableReason: unavailableReason as NonNullable<
            CheckoutSummaryLine['unavailableReason']
          >,
        }
      : {}),
  };
}

export function decodeSummary(value: unknown): CheckoutSummary {
  if (!isRecord(value) || !Array.isArray(value.items)) invalid();
  const { cartId, itemCount, total, currency, fingerprint, checkoutAllowed, checkoutInProgress } =
    value;
  if (
    typeof cartId !== 'string' ||
    typeof itemCount !== 'number' ||
    typeof total !== 'string' ||
    !MONEY.test(total) ||
    currency !== 'GTQ' ||
    typeof fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(fingerprint) ||
    typeof checkoutAllowed !== 'boolean' ||
    typeof checkoutInProgress !== 'boolean'
  ) {
    invalid();
  }
  return {
    cartId,
    items: value.items.map(decodeSummaryLine),
    itemCount,
    total,
    currency,
    fingerprint,
    checkoutAllowed,
    checkoutInProgress,
  };
}

function decodeOrderLine(value: unknown): OrderLine {
  if (!isRecord(value)) invalid();
  const { productId, name, quantity, unitPrice, lineTotal } = value;
  if (
    typeof productId !== 'string' ||
    typeof name !== 'string' ||
    typeof quantity !== 'number' ||
    typeof unitPrice !== 'string' ||
    !MONEY.test(unitPrice) ||
    typeof lineTotal !== 'string' ||
    !MONEY.test(lineTotal)
  ) {
    invalid();
  }
  return { productId, name, quantity, unitPrice, lineTotal };
}

function decodeShipping(value: unknown): ShippingDetails {
  if (!isRecord(value)) invalid();
  const { recipientName, phone, department, municipality, address, references } = value;
  if (
    typeof recipientName !== 'string' ||
    typeof phone !== 'string' ||
    typeof department !== 'string' ||
    typeof municipality !== 'string' ||
    typeof address !== 'string' ||
    (references !== undefined && typeof references !== 'string')
  ) {
    invalid();
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

export function decodeOrder(value: unknown): OrderConfirmation {
  if (!isRecord(value) || !Array.isArray(value.items)) invalid();
  const { id, orderNumber, status, total, currency, itemCount, paymentReference, createdAt } =
    value;
  if (
    typeof id !== 'string' ||
    !UUID.test(id) ||
    typeof orderNumber !== 'string' ||
    !/^SP-\d+$/.test(orderNumber) ||
    !['PAGADO', 'EN_PREPARACION', 'ENVIADO', 'ENTREGADO', 'CANCELADO'].includes(status as string) ||
    typeof total !== 'string' ||
    !MONEY.test(total) ||
    currency !== 'GTQ' ||
    typeof itemCount !== 'number' ||
    typeof paymentReference !== 'string' ||
    !/^SIM-[0-9A-F]+$/.test(paymentReference) ||
    typeof createdAt !== 'string'
  ) {
    invalid();
  }
  return {
    id,
    orderNumber,
    status: status as OrderConfirmation['status'],
    total,
    currency,
    itemCount,
    paymentReference,
    createdAt,
    items: value.items.map(decodeOrderLine),
    shipping: decodeShipping(value.shipping),
  };
}

/** Petición autenticada a Commerce con un reintento tras renovar la sesión (compartida con M05). */
export async function execute(
  path: string,
  init: RequestInit | undefined,
  retry = true,
): Promise<{ status: number; payload: unknown }> {
  let response: Response;
  try {
    response = await fetch(`${COMMERCE_BASE_URL}${path}`, {
      credentials: 'include',
      redirect: 'error',
      ...init,
      headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    // Sin respuesta: la confirmación pudo aplicarse; se trata como pendiente y se reintenta con la misma clave.
    throw new CheckoutApiError('No hubo respuesta del servidor', 0, 'NETWORK_ERROR');
  }
  if (response.status === 401 && retry) {
    await refreshSession();
    return execute(path, init, false);
  }
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    payload = undefined;
  }
  if (!response.ok) throw decodeError(response.status, payload);
  return { status: response.status, payload };
}

export async function getCheckoutSummary(signal?: AbortSignal): Promise<CheckoutSummary> {
  const { payload } = await execute('/checkout/summary', signal ? { signal } : undefined);
  return decodeSummary(payload);
}

/**
 * Confirma el pedido. `idempotencyKey` identifica el intento: se reutiliza en reintentos técnicos y se
 * renueva tras un resultado final (rechazo, conflicto o cambio de resumen). El cliente nunca envía importes.
 */
export async function placeOrder(
  request: PlaceOrderRequest,
  idempotencyKey: string,
): Promise<{ created: boolean; order: OrderConfirmation }> {
  const csrf = await csrfToken();
  const { status, payload } = await execute('/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(request),
  });
  return { created: status === 201, order: decodeOrder(payload) };
}

export async function getOrder(orderId: string, signal?: AbortSignal): Promise<OrderConfirmation> {
  const { payload } = await execute(
    `/orders/${encodeURIComponent(orderId)}`,
    signal ? { signal } : undefined,
  );
  return decodeOrder(payload);
}
