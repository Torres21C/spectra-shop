import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AuthPrincipal {
  userId: string;
  sessionId: string;
  role: 'CLIENTE' | 'ADMIN';
}

export interface IdentityRequest extends Request {
  requestId: string;
  auth?: AuthPrincipal;
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: IdentityRequest, response: Response, next: NextFunction): void {
    const suppliedId = request.header('x-request-id');
    request.requestId = suppliedId && UUID_PATTERN.test(suppliedId) ? suppliedId : randomUUID();
    response.setHeader('X-Request-Id', request.requestId);
    next();
  }
}
