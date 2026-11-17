import { timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { ValidatedSession } from '@spectra/contracts';
import type { RequestWithId } from '../common/request-context.js';
import { adminConfig } from './admin.config.js';
import { IdentityClientService } from './identity-client.service.js';
import { JwtVerifierService } from './jwt-verifier.service.js';

export interface AdminRequest extends RequestWithId {
  auth?: ValidatedSession;
}

/**
 * M06 mínimo: solo ADMIN con JWT ES256 válido y sesión activa en Identity. El JWT local y la sesión
 * validada deben coincidir (usuario, sesión y rol); cualquier diferencia se trata como no autenticado.
 */
@Injectable()
export class AdminAccessGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtVerifierService,
    private readonly identity: IdentityClientService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const raw = request.cookies?.[adminConfig.accessCookieName()] as unknown;
    const token = typeof raw === 'string' ? raw : '';
    const local = await this.jwt.verify(token);
    const active = await this.identity.validateAndTouch(token, request.requestId);
    if (
      local.userId !== active.userId ||
      local.sessionId !== active.sessionId ||
      local.role !== active.role
    ) {
      await this.jwt.verify('');
    }
    if (active.role !== 'ADMIN') {
      throw new ForbiddenException({ code: 'REQUEST_REJECTED', message: 'Solicitud rechazada' });
    }
    request.auth = active;
    return true;
  }
}

/** CSRF de doble envío (cookie de Identity + cabecera) y Origin en lista blanca para escrituras. */
export function assertCsrf(request: AdminRequest): void {
  const origin = request.header('origin');
  const supplied = request.header('x-csrf-token');
  const expected = request.cookies?.[adminConfig.csrfCookieName()] as unknown;
  if (
    !origin ||
    !adminConfig.allowedOrigins().has(origin) ||
    typeof supplied !== 'string' ||
    typeof expected !== 'string' ||
    supplied.length !== expected.length ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  ) {
    throw new ForbiddenException({ code: 'CSRF_INVALID', message: 'Solicitud rechazada' });
  }
}
