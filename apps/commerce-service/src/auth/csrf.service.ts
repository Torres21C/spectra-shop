import { timingSafeEqual } from 'node:crypto';
import { ForbiddenException, Injectable } from '@nestjs/common';
import type { CommerceRequest } from '../common/request-context.js';
import { commerceConfig, csrfCookieName } from '../config/commerce.config.js';

@Injectable()
export class CsrfService {
  assert(request: CommerceRequest): void {
    const origin = request.header('origin');
    const supplied = request.header('x-csrf-token');
    const expected = request.cookies?.[csrfCookieName()] as unknown;
    if (
      !origin ||
      !commerceConfig.allowedOrigins.has(origin) ||
      typeof supplied !== 'string' ||
      typeof expected !== 'string' ||
      supplied.length !== expected.length ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    ) {
      throw new ForbiddenException({ code: 'CSRF_INVALID', message: 'Solicitud rechazada' });
    }
  }
}
