import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { AuthException } from '../common/auth.exception.js';
import type { IdentityRequest } from '../common/request-context.js';
import { identityConfig } from '../config/identity.config.js';
import { CookieService } from './cookie.service.js';

@Injectable()
export class CsrfService {
  constructor(private readonly cookies: CookieService) {}

  issue(response: Response): string {
    const token = randomBytes(32).toString('base64url');
    this.cookies.setCsrf(response, token);
    return token;
  }

  assert(request: IdentityRequest): void {
    const origin = request.header('origin');
    const supplied = request.header('x-csrf-token');
    const expected = request.cookies?.[this.cookies.names.csrf] as unknown;
    if (
      !origin ||
      !identityConfig.allowedOrigins.has(origin) ||
      typeof supplied !== 'string' ||
      typeof expected !== 'string' ||
      supplied.length !== expected.length ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    ) {
      throw new AuthException(403, 'CSRF_INVALID', 'Solicitud rechazada');
    }
  }
}
