import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { accessCookieName } from '../config/commerce.config.js';
import type { CommerceRequest } from '../common/request-context.js';
import { IdentityClientService } from './identity-client.service.js';
import { JwtVerifierService } from './jwt-verifier.service.js';

/**
 * M06 mínimo: rutas /admin de Commerce. Mismo contrato que CartAccessGuard (JWT ES256 local + sesión
 * activa en Identity, ambos coincidentes), pero solo admite el rol ADMIN.
 */
@Injectable()
export class AdminAccessGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtVerifierService,
    private readonly identity: IdentityClientService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<CommerceRequest>();
    const raw = request.cookies?.[accessCookieName()] as unknown;
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
