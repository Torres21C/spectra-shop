import { Injectable } from '@nestjs/common';
import type {
  CheckoutConflictLine,
  StockReservation,
  StockReservationFulfillment,
  StockReservationLine,
  StockReservationLineRequest,
  StockReservationState,
  StockReservationStatus,
} from '@spectra/contracts';
import { commerceConfig } from '../config/commerce.config.js';

/** Fallo técnico ambiguo: no se sabe si Catalog aplicó la operación. */
export class InventoryUnavailableError extends Error {
  constructor(readonly operation: string) {
    super(`inventory ${operation} unavailable`);
    this.name = 'InventoryUnavailableError';
  }
}

/** DT-08: Catalog respondió, pero con un contenido que no cumple el contrato. */
export class InventoryInvalidResponseError extends Error {
  constructor(readonly operation: string) {
    super(`inventory ${operation} invalid response`);
    this.name = 'InventoryInvalidResponseError';
  }
}

/** DT-08: conflictos semánticos de `fulfill`; requieren intervención y nunca modifican inventario. */
export type FulfillConflictCode = 'RESERVATION_STATE_CONFLICT' | 'ORDER_RESERVATION_MISMATCH';

export type FulfillResult =
  | { readonly kind: 'fulfilled'; readonly fulfillment: StockReservationFulfillment }
  | { readonly kind: 'conflict'; readonly code: FulfillConflictCode };

export type ReserveResult =
  | { readonly kind: 'reserved'; readonly reservation: StockReservation }
  | { readonly kind: 'conflict'; readonly conflicts: readonly CheckoutConflictLine[] }
  | { readonly kind: 'released' };

export type ConfirmResult =
  | { readonly kind: 'confirmed'; readonly reservation: StockReservation }
  | { readonly kind: 'released' };

const STATUSES: readonly StockReservationStatus[] = [
  'PENDING',
  'CONFIRMED',
  'FULFILLED',
  'RESTOCKED',
  'RELEASED',
];
/** Después del punto de no retorno: la reserva está confirmada aunque ya se haya reconocido. */
const COMMITTED: readonly StockReservationStatus[] = ['CONFIRMED', 'FULFILLED', 'RESTOCKED'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRICE = /^\d{1,8}\.\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeLine(value: unknown): StockReservationLine {
  if (!isRecord(value)) throw new Error('line');
  const { productId, name, quantity, unitPrice } = value;
  if (
    typeof productId !== 'string' ||
    !UUID.test(productId) ||
    typeof name !== 'string' ||
    typeof quantity !== 'number' ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 10 ||
    typeof unitPrice !== 'string' ||
    !PRICE.test(unitPrice)
  ) {
    throw new Error('line');
  }
  return { productId, name, quantity, unitPrice };
}

function decodeReservation(value: unknown, reservationId: string): StockReservation {
  if (!isRecord(value) || !Array.isArray(value.lines)) throw new Error('reservation');
  const { status, expiresAt } = value;
  if (
    value.reservationId !== reservationId ||
    !STATUSES.includes(status as StockReservationStatus) ||
    typeof expiresAt !== 'string'
  ) {
    throw new Error('reservation');
  }
  return {
    reservationId,
    status: status as StockReservationStatus,
    expiresAt,
    lines: value.lines.map(decodeLine),
  };
}

function decodeConflicts(value: unknown): CheckoutConflictLine[] {
  if (!isRecord(value) || value.code !== 'STOCK_CONFLICT' || !Array.isArray(value.conflicts)) {
    throw new Error('conflict');
  }
  return value.conflicts.map((entry: unknown) => {
    if (!isRecord(entry)) throw new Error('conflict');
    const { productId, reason, available } = entry;
    if (
      typeof productId !== 'string' ||
      !UUID.test(productId) ||
      !['INACTIVE', 'INSUFFICIENT_STOCK', 'PRICE_CHANGED'].includes(reason as string) ||
      typeof available !== 'number' ||
      !Number.isInteger(available) ||
      available < 0 ||
      available > 10
    ) {
      throw new Error('conflict');
    }
    return { productId, reason: reason as CheckoutConflictLine['reason'], available };
  });
}

function decodeFulfillment(
  value: unknown,
  reservationId: string,
  orderId: string,
): StockReservationFulfillment {
  if (!isRecord(value)) throw new Error('fulfillment');
  const { status, confirmedAt, fulfilledAt } = value;
  if (
    value.reservationId !== reservationId ||
    value.orderId !== orderId ||
    (status !== 'FULFILLED' && status !== 'RESTOCKED') ||
    typeof confirmedAt !== 'string' ||
    !ISO_DATE.test(confirmedAt) ||
    typeof fulfilledAt !== 'string' ||
    !ISO_DATE.test(fulfilledAt)
  ) {
    throw new Error('fulfillment');
  }
  return { reservationId, orderId, status, confirmedAt, fulfilledAt };
}

function codeOf(value: unknown): string | undefined {
  return isRecord(value) && typeof value.code === 'string' ? value.code : undefined;
}

/**
 * Cliente de la API interna de inventario de Catalog (listener no publicado, token de alcance
 * de inventario). Las respuestas se validan estrictamente; cualquier ambigüedad falla cerrado.
 */
@Injectable()
export class InventoryClientService {
  async reserve(
    reservationId: string,
    lines: readonly StockReservationLineRequest[],
    requestId: string,
  ): Promise<ReserveResult> {
    const { status, body } = await this.call('reserve', 'POST', '', requestId, {
      reservationId,
      lines,
    });
    try {
      if (status === 200 || status === 201) {
        return { kind: 'reserved', reservation: decodeReservation(body, reservationId) };
      }
      if (status === 409 && codeOf(body) === 'STOCK_CONFLICT') {
        return { kind: 'conflict', conflicts: decodeConflicts(body) };
      }
      if (status === 409 && codeOf(body) === 'RESERVATION_RELEASED') return { kind: 'released' };
    } catch {
      throw new InventoryUnavailableError('reserve');
    }
    throw new InventoryUnavailableError('reserve');
  }

  async confirm(reservationId: string, requestId: string): Promise<ConfirmResult> {
    const { status, body } = await this.call(
      'confirm',
      'POST',
      `/${reservationId}/confirm`,
      requestId,
      {},
    );
    try {
      if (status === 200) {
        const reservation = decodeReservation(body, reservationId);
        if (COMMITTED.includes(reservation.status)) return { kind: 'confirmed', reservation };
      }
      if (status === 409 && codeOf(body) === 'RESERVATION_RELEASED') return { kind: 'released' };
    } catch {
      throw new InventoryUnavailableError('confirm');
    }
    throw new InventoryUnavailableError('confirm');
  }

  /**
   * DT-08: reconocimiento de entrega. 201/200 con el mismo pedido = reconocido (idempotente).
   * 409/404 de estado o vinculación = conflicto semántico. Cualquier otra respuesta o fallo de red
   * es ambiguo y se reintenta (Catalog pudo haberlo aplicado; la repetición converge con 200).
   */
  async fulfill(reservationId: string, orderId: string, requestId: string): Promise<FulfillResult> {
    const { status, body } = await this.call(
      'fulfill',
      'POST',
      `/${reservationId}/fulfill`,
      requestId,
      { orderId },
    );
    if (status === 200 || status === 201) {
      try {
        return { kind: 'fulfilled', fulfillment: decodeFulfillment(body, reservationId, orderId) };
      } catch {
        throw new InventoryInvalidResponseError('fulfill');
      }
    }
    const code = codeOf(body);
    if (
      status === 409 &&
      (code === 'RESERVATION_ORDER_MISMATCH' || code === 'ORDER_RESERVATION_MISMATCH')
    ) {
      return { kind: 'conflict', code: 'ORDER_RESERVATION_MISMATCH' };
    }
    if (
      (status === 409 &&
        (code === 'RESERVATION_NOT_CONFIRMED' || code === 'RESERVATION_RELEASED')) ||
      (status === 404 && code === 'RESERVATION_NOT_FOUND')
    ) {
      return { kind: 'conflict', code: 'RESERVATION_STATE_CONFLICT' };
    }
    if (status >= 400 && status < 500) throw new InventoryInvalidResponseError('fulfill');
    throw new InventoryUnavailableError('fulfill');
  }

  async release(reservationId: string, requestId: string): Promise<StockReservationState> {
    const { status, body } = await this.call(
      'release',
      'POST',
      `/${reservationId}/release`,
      requestId,
      {},
    );
    if (status === 409 && codeOf(body) === 'RESERVATION_CONFIRMED') {
      return { reservationId, status: 'CONFIRMED', expired: false, lines: [] };
    }
    if (status !== 200) throw new InventoryUnavailableError('release');
    return this.decodeState(body, reservationId, 'release');
  }

  async state(reservationId: string, requestId: string): Promise<StockReservationState> {
    const { status, body } = await this.call('state', 'GET', `/${reservationId}`, requestId);
    if (status !== 200) throw new InventoryUnavailableError('state');
    return this.decodeState(body, reservationId, 'state');
  }

  private decodeState(
    body: unknown,
    reservationId: string,
    operation: string,
  ): StockReservationState {
    try {
      if (!isRecord(body) || !Array.isArray(body.lines)) throw new Error('state');
      const { status, expired } = body;
      if (
        body.reservationId !== reservationId ||
        (status !== 'NOT_FOUND' && !STATUSES.includes(status as StockReservationStatus)) ||
        typeof expired !== 'boolean'
      ) {
        throw new Error('state');
      }
      return {
        reservationId,
        status: status as StockReservationState['status'],
        expired,
        lines: body.lines.map(decodeLine),
      };
    } catch {
      throw new InventoryUnavailableError(operation);
    }
  }

  private async call(
    operation: string,
    method: 'GET' | 'POST',
    suffix: string,
    requestId: string,
    payload?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const url = new URL(`/internal/catalog/stock-reservations${suffix}`, commerceConfig.catalogUrl);
    try {
      const response = await fetch(url, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(commerceConfig.timeoutMs),
        headers: {
          Accept: 'application/json',
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
          'X-Spectra-Internal-Token': commerceConfig.inventoryToken,
          'X-Request-Id': requestId,
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      const text = await response.text();
      return { status: response.status, body: text ? (JSON.parse(text) as unknown) : undefined };
    } catch {
      throw new InventoryUnavailableError(operation);
    }
  }
}
