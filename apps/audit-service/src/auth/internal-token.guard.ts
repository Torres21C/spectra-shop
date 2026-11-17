import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import { readInternalTokens } from '../config.js';

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * Ingesta servicio a servicio. El listener interno no se publica al host; además exige el token
 * interno compartido. Responde 404 para no revelar la ruta a quien no presenta credencial.
 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  private readonly accepted = readInternalTokens().map(digest);

  canActivate(context: ExecutionContext): boolean {
    const supplied = context
      .switchToHttp()
      .getRequest<Request>()
      .header('x-spectra-internal-token');
    if (typeof supplied !== 'string' || supplied.length < 32) throw new NotFoundException();
    const candidate = digest(supplied);
    if (!this.accepted.some((token) => timingSafeEqual(token, candidate))) {
      throw new NotFoundException();
    }
    return true;
  }
}
