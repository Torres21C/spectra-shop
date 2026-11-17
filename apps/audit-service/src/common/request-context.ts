import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { ValidatedSession } from '@spectra/contracts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AuditRequest extends Request {
  requestId: string;
  auth?: ValidatedSession;
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: AuditRequest, response: Response, next: NextFunction): void {
    const supplied = request.header('x-request-id');
    request.requestId = supplied && UUID_PATTERN.test(supplied) ? supplied : randomUUID();
    response.setHeader('X-Request-Id', request.requestId);
    next();
  }
}
