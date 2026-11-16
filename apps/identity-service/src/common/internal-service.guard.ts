import { createHash, timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request } from 'express';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

@Injectable()
export class InternalServiceGuard implements CanActivate {
  private readonly accepted: readonly Buffer[];

  constructor() {
    const tokens = (process.env.SPECTRA_INTERNAL_TOKENS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    if (tokens.length < 1 || tokens.length > 2 || tokens.some((value) => value.length < 32)) {
      throw new Error(
        'SPECTRA_INTERNAL_TOKENS requiere uno o dos tokens de al menos 32 caracteres',
      );
    }
    this.accepted = tokens.map(digest);
  }

  canActivate(context: ExecutionContext): boolean {
    const supplied = context
      .switchToHttp()
      .getRequest<Request>()
      .header('x-spectra-internal-token');
    if (
      !supplied ||
      !this.accepted.some((expected) => timingSafeEqual(digest(supplied), expected))
    ) {
      throw new ServiceUnavailableException({
        code: 'INTERNAL_SERVICE_UNAVAILABLE',
        message: 'Servicio interno no disponible',
      });
    }
    return true;
  }
}
