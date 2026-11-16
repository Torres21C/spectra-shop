import type { ApiErrorResponse, CartLine, ShoppingCart } from '@spectra/contracts';
import { csrfToken, refreshSession } from '../auth/auth-api.js';

const COMMERCE_BASE_URL = (
  import.meta.env.VITE_COMMERCE_API_URL ?? 'http://127.0.0.1:3003'
).replace(/\/$/, '');

export class CartApiError extends Error {
  readonly code: string | undefined;
  readonly requestId: string | undefined;

  constructor(message: string, code?: string, requestId?: string) {
    super(message);
    this.name = 'CartApiError';
    this.code = code;
    this.requestId = requestId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeError(value: unknown): ApiErrorResponse | undefined {
  if (!isRecord(value)) return undefined;
  const { statusCode, code, message, requestId, timestamp } = value;
  return typeof statusCode === 'number' &&
    typeof code === 'string' &&
    typeof message === 'string' &&
    typeof requestId === 'string' &&
    typeof timestamp === 'string'
    ? { statusCode, code, message, requestId, timestamp }
    : undefined;
}

function decodeLine(value: unknown): CartLine {
  if (!isRecord(value)) throw new CartApiError('La respuesta del carrito no es válida');
  const { id, productId, name, quantity, unitPrice, subtotal, available, unavailableReason } =
    value;
  if (
    typeof id !== 'string' ||
    typeof productId !== 'string' ||
    typeof name !== 'string' ||
    typeof quantity !== 'number' ||
    typeof unitPrice !== 'string' ||
    typeof subtotal !== 'string' ||
    typeof available !== 'boolean' ||
    (unavailableReason !== undefined &&
      !['INACTIVE', 'OUT_OF_STOCK', 'INSUFFICIENT_STOCK'].includes(unavailableReason as string))
  ) {
    throw new CartApiError('La respuesta del carrito no es válida');
  }
  const line: CartLine = {
    id,
    productId,
    name,
    quantity,
    unitPrice,
    subtotal,
    available,
  };
  if (unavailableReason) {
    return {
      ...line,
      unavailableReason: unavailableReason as NonNullable<CartLine['unavailableReason']>,
    };
  }
  return line;
}

function decodeCart(value: unknown): ShoppingCart {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new CartApiError('La respuesta del carrito no es válida');
  }
  const { id, status, itemCount, distinctItems, total, currency, checkoutAllowed, updatedAt } =
    value;
  if (
    typeof id !== 'string' ||
    (status !== 'ACTIVO' && status !== 'CONVERTIDO') ||
    typeof itemCount !== 'number' ||
    typeof distinctItems !== 'number' ||
    typeof total !== 'string' ||
    currency !== 'GTQ' ||
    typeof checkoutAllowed !== 'boolean' ||
    typeof updatedAt !== 'string'
  ) {
    throw new CartApiError('La respuesta del carrito no es válida');
  }
  return {
    id,
    status,
    items: value.items.map(decodeLine),
    itemCount,
    distinctItems,
    total,
    currency,
    checkoutAllowed,
    updatedAt,
  };
}

async function execute(path: string, init?: RequestInit, retry = true): Promise<ShoppingCart> {
  const response = await fetch(`${COMMERCE_BASE_URL}${path}`, {
    credentials: 'include',
    redirect: 'error',
    headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (response.status === 401 && retry) {
    await refreshSession();
    return execute(path, init, false);
  }
  const payload: unknown = JSON.parse(await response.text());
  if (!response.ok) {
    const error = decodeError(payload);
    throw new CartApiError(
      error?.message ?? 'No fue posible completar la solicitud',
      error?.code,
      error?.requestId,
    );
  }
  return decodeCart(payload);
}

async function mutate(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<ShoppingCart> {
  const csrf = await csrfToken();
  return execute(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

export function getCart(signal?: AbortSignal): Promise<ShoppingCart> {
  return execute('/cart', signal ? { signal } : undefined);
}

export function addCartItem(productId: string, quantity: number): Promise<ShoppingCart> {
  return mutate('POST', '/cart/items', { productId, quantity });
}

export function updateCartItem(itemId: string, quantity: number): Promise<ShoppingCart> {
  return mutate('PATCH', `/cart/items/${encodeURIComponent(itemId)}`, { quantity });
}

export function removeCartItem(itemId: string): Promise<ShoppingCart> {
  return mutate('DELETE', `/cart/items/${encodeURIComponent(itemId)}`);
}
