import { createHash, timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request } from 'express';

const HEADER = 'x-spectra-internal-token';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function readInternalTokens(variable: string): string[] {
  const tokens = (process.env[variable] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (tokens.length < 1 || tokens.length > 2 || tokens.some((value) => value.length < 32)) {
    throw new Error(`${variable} requiere uno o dos tokens de al menos 32 caracteres`);
  }
  return tokens;
}

/**
 * Autenticación servicio a servicio por token aleatorio. Cada alcance tiene su propia
 * variable para que una credencial de lectura no habilite operaciones de inventario.
 */
abstract class InternalTokenGuard implements CanActivate {
  private readonly accepted: readonly Buffer[];

  protected constructor(tokens: readonly string[]) {
    this.accepted = tokens.map(digest);
  }

  canActivate(context: ExecutionContext): boolean {
    const supplied = context.switchToHttp().getRequest<Request>().header(HEADER);
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

/** Alcance de lectura usado por el snapshot del carrito (M03). */
@Injectable()
export class InternalServiceGuard extends InternalTokenGuard {
  constructor() {
    super(readInternalTokens('SPECTRA_INTERNAL_TOKENS'));
  }
}

/** Alcance de escritura de inventario: solo Commerce posee este token (M04). */
@Injectable()
export class InventoryServiceGuard extends InternalTokenGuard {
  constructor() {
    const inventory = readInternalTokens('CATALOG_INVENTORY_TOKENS');
    const shared = new Set(readInternalTokens('SPECTRA_INTERNAL_TOKENS'));
    if (inventory.some((token) => shared.has(token))) {
      throw new Error('CATALOG_INVENTORY_TOKENS debe ser distinto de SPECTRA_INTERNAL_TOKENS');
    }
    super(inventory);
  }
}
