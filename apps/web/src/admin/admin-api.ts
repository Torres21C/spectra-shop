import type { ApiErrorResponse } from '@spectra/contracts';
import { csrfToken, refreshSession } from '../auth/auth-api.js';

const CATALOG_BASE_URL = (import.meta.env.VITE_CATALOG_API_URL ?? 'http://127.0.0.1:3002').replace(
  /\/$/,
  '',
);
const AUDIT_BASE_URL = (import.meta.env.VITE_AUDIT_API_URL ?? 'http://127.0.0.1:3004').replace(
  /\/$/,
  '',
);

export class AdminApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly requestId: string | undefined;

  constructor(message: string, status: number, code?: string, requestId?: string) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export interface NewProductInput {
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly categoryId: string;
  readonly price: string;
  readonly stock: number;
}

export interface CreatedProduct {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly price: string;
  readonly stock: number;
}

export interface AuditEventItem {
  readonly id: string;
  readonly sourceService: string;
  readonly eventType: string;
  readonly result: string;
  readonly actorId: string | null;
  readonly actorRole: string | null;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly sourceIp: string | null;
  readonly requestId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

const MESSAGES: Readonly<Record<number, string>> = {
  401: 'Tu sesión expiró. Inicia sesión de nuevo.',
  403: 'No tienes permiso para esta acción.',
  409: 'El SKU ya existe.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeError(value: unknown): Partial<ApiErrorResponse> {
  if (!isRecord(value)) return {};
  return {
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    ...(typeof value.requestId === 'string' ? { requestId: value.requestId } : {}),
  };
}

async function request(url: string, init: RequestInit, retry = true): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: 'include',
      redirect: 'error',
      ...init,
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
    });
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new AdminApiError('No hubo respuesta del servidor', 0);
  }
  if (response.status === 401 && retry) {
    try {
      await refreshSession();
    } catch {
      throw new AdminApiError(MESSAGES[401]!, 401, 'AUTH_REQUIRED');
    }
    return request(url, init, false);
  }
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    payload = undefined;
  }
  if (!response.ok) {
    const { code, requestId } = decodeError(payload);
    const message =
      MESSAGES[response.status] ??
      (response.status === 400
        ? 'Revisa los datos del formulario.'
        : 'No fue posible completar la solicitud');
    throw new AdminApiError(message, response.status, code, requestId);
  }
  return payload;
}

/** M06 mínimo: alta de producto. Solo se envían los campos del formulario (lista blanca en servidor). */
export async function createProduct(input: NewProductInput): Promise<CreatedProduct> {
  const csrf = await csrfToken();
  const payload = await request(`${CATALOG_BASE_URL}/admin/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({
      sku: input.sku,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      categoryId: input.categoryId,
      price: input.price,
      stock: input.stock,
    }),
  });
  if (
    !isRecord(payload) ||
    typeof payload.id !== 'string' ||
    typeof payload.sku !== 'string' ||
    typeof payload.name !== 'string' ||
    typeof payload.price !== 'string' ||
    typeof payload.stock !== 'number'
  ) {
    throw new AdminApiError('La respuesta del servidor no es válida', 502);
  }
  return {
    id: payload.id,
    sku: payload.sku,
    name: payload.name,
    price: payload.price,
    stock: payload.stock,
  };
}

const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

function decodeAuditEvent(value: unknown): AuditEventItem {
  if (!isRecord(value)) throw new AdminApiError('La respuesta de auditoría no es válida', 502);
  const {
    id,
    sourceService,
    eventType,
    result,
    actorId,
    actorRole,
    resourceType,
    resourceId,
    sourceIp,
    requestId,
    metadata,
    occurredAt,
  } = value;
  if (
    typeof id !== 'string' ||
    typeof sourceService !== 'string' ||
    typeof eventType !== 'string' ||
    typeof result !== 'string' ||
    !nullableString(actorId) ||
    !nullableString(actorRole) ||
    typeof resourceType !== 'string' ||
    !nullableString(resourceId) ||
    !nullableString(sourceIp) ||
    !nullableString(requestId) ||
    !isRecord(metadata) ||
    typeof occurredAt !== 'string'
  ) {
    throw new AdminApiError('La respuesta de auditoría no es válida', 502);
  }
  return {
    id,
    sourceService,
    eventType,
    result,
    actorId,
    actorRole,
    resourceType,
    resourceId,
    sourceIp,
    requestId,
    metadata,
    occurredAt,
  };
}

/** M07 mínimo: últimos eventos de auditoría (solo lectura; el servidor exige ADMIN). */
export async function getAuditEvents(signal?: AbortSignal): Promise<AuditEventItem[]> {
  const payload = await request(`${AUDIT_BASE_URL}/admin/audit-events?limit=50`, {
    method: 'GET',
    ...(signal ? { signal } : {}),
  });
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new AdminApiError('La respuesta de auditoría no es válida', 502);
  }
  return payload.items.map(decodeAuditEvent);
}
