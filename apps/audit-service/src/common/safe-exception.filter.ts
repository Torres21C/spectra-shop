import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AuditRequest } from './request-context.js';

const SAFE_CODES = new Set(['AUTH_REQUIRED', 'IDENTITY_UNAVAILABLE', 'INVALID_AUDIT_EVENT']);

/** Errores genéricos (RS11): sin trazas, SQL ni detalles internos; con ID de correlación. */
@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SafeExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<AuditRequest>();
    const response = context.getResponse<Response>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    let code =
      status === 400
        ? 'VALIDATION_ERROR'
        : status === 404
          ? 'RESOURCE_NOT_FOUND'
          : status >= 500
            ? 'INTERNAL_ERROR'
            : 'REQUEST_REJECTED';
    let message =
      status === 400
        ? 'Parámetros inválidos'
        : status >= 500
          ? 'No fue posible completar la solicitud'
          : 'Solicitud rechazada';
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null) {
        const candidateCode = Reflect.get(body, 'code') as unknown;
        const candidateMessage = Reflect.get(body, 'message') as unknown;
        if (
          typeof candidateCode === 'string' &&
          typeof candidateMessage === 'string' &&
          SAFE_CODES.has(candidateCode)
        ) {
          code = candidateCode;
          message = candidateMessage;
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
    response.status(status).json({
      statusCode: status,
      code,
      message,
      requestId: request.requestId,
      timestamp: new Date().toISOString(),
    });
  }
}
