import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { ApiErrorDetails, ApiErrorResponse, CheckoutConflictLine } from '@spectra/contracts';
import type { Response } from 'express';
import type { CommerceRequest } from './request-context.js';

const SAFE_CODES = new Set([
  'AUTH_REQUIRED',
  'SESSION_EXPIRED',
  'CSRF_INVALID',
  'CART_ITEM_NOT_FOUND',
  'PRODUCT_NOT_AVAILABLE',
  'INSUFFICIENT_STOCK',
  'CART_LINE_LIMIT',
  'CATALOG_UNAVAILABLE',
  'IDENTITY_UNAVAILABLE',
  'CART_LOCKED_FOR_CHECKOUT',
  'CHECKOUT_CART_EMPTY',
  'CHECKOUT_IN_PROGRESS',
  'CHECKOUT_PENDING',
  'CHECKOUT_EXPIRED',
  'CHECKOUT_RATE_LIMITED',
  'CHECKOUT_STOCK_CONFLICT',
  'CHECKOUT_SUMMARY_CHANGED',
  'PAYMENT_SIMULATED_REJECTED',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_KEY_EXPIRED',
  'ORDER_NOT_FOUND',
]);

const CONFLICT_REASONS = new Set(['INACTIVE', 'INSUFFICIENT_STOCK', 'PRICE_CHANGED']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Solo se exponen detalles con forma conocida: identificadores, motivo y unidades disponibles. */
function safeDetails(code: string, value: unknown): ApiErrorDetails | undefined {
  if (code !== 'CHECKOUT_STOCK_CONFLICT' || typeof value !== 'object' || value === null) {
    return undefined;
  }
  const conflicts = (value as Record<string, unknown>)['conflicts'];
  if (!Array.isArray(conflicts)) return undefined;
  const safe: CheckoutConflictLine[] = [];
  for (const entry of conflicts.slice(0, 20)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { productId, reason, available } = entry as Record<string, unknown>;
    if (
      typeof productId === 'string' &&
      UUID.test(productId) &&
      typeof reason === 'string' &&
      CONFLICT_REASONS.has(reason) &&
      typeof available === 'number' &&
      Number.isInteger(available)
    ) {
      safe.push({
        productId,
        reason: reason as CheckoutConflictLine['reason'],
        available: Math.max(0, Math.min(available, 10)),
      });
    }
  }
  return { conflicts: safe };
}

@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SafeExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<CommerceRequest>();
    const response = context.getResponse<Response>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    let code = this.codeFor(status);
    let message = this.messageFor(status);
    let details: ApiErrorDetails | undefined;

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null) {
        const record = body as Record<string, unknown>;
        const candidateCode = record['code'];
        const candidateMessage = record['message'];
        if (
          typeof candidateCode === 'string' &&
          typeof candidateMessage === 'string' &&
          SAFE_CODES.has(candidateCode)
        ) {
          code = candidateCode;
          message = candidateMessage;
          details = safeDetails(candidateCode, record['details']);
        }
      }
    } else {
      this.logger.error({
        event: 'unhandled_exception',
        requestId: request.requestId,
        method: request.method,
        path: request.path,
        exceptionType: exception instanceof Error ? exception.name : 'UnknownError',
      });
    }

    const payload: ApiErrorResponse = {
      statusCode: status,
      code,
      message,
      requestId: request.requestId,
      timestamp: new Date().toISOString(),
      ...(details ? { details } : {}),
    };
    response.status(status).json(payload);
  }

  private codeFor(status: number): string {
    if (status === 400) return 'VALIDATION_ERROR';
    if (status === 401) return 'AUTH_REQUIRED';
    if (status === 403) return 'REQUEST_REJECTED';
    if (status === 404) return 'RESOURCE_NOT_FOUND';
    if (status === 409) return 'CONFLICT';
    if (status === 422) return 'REQUEST_REJECTED';
    if (status === 429) return 'RATE_LIMIT_EXCEEDED';
    if (status === 503) return 'SERVICE_UNAVAILABLE';
    return status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_REJECTED';
  }

  private messageFor(status: number): string {
    if (status === 400) return 'Parámetros inválidos';
    if (status === 401) return 'Autenticación requerida';
    if (status === 403) return 'Solicitud rechazada';
    if (status === 404) return 'Recurso no disponible';
    if (status === 409) return 'No fue posible completar la operación';
    if (status === 422) return 'Solicitud rechazada';
    if (status === 429) return 'Demasiadas solicitudes';
    return status >= 500 ? 'No fue posible completar la solicitud' : 'Solicitud rechazada';
  }
}
