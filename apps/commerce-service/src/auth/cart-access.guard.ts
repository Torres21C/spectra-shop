import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { accessCookieName } from '../config/commerce.config.js';
import type { CommerceRequest } from '../common/request-context.js';
import { IdentityClientService } from './identity-client.service.js';
import { JwtVerifierService } from './jwt-verifier.service.js';

@Injectable()
export class CartAccessGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtVerifierService,
    private readonly identity: IdentityClientService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<CommerceRequest>();
    const raw = request.cookies?.[accessCookieName()] as unknown;
    if (typeof raw !== 'string') await this.jwt.verify('');
    const local = await this.jwt.verify(raw as string);
    const active = await this.identity.validateAndTouch(raw as string, request.requestId);
    if (
      local.userId !== active.userId ||
      local.sessionId !== active.sessionId ||
      local.role !== active.role
    ) {
      await this.jwt.verify('');
    }
    if (active.role !== 'CLIENTE') {
      throw new ForbiddenException({ code: 'REQUEST_REJECTED', message: 'Solicitud rechazada' });
    }
    request.auth = active;
    return true;
  }
}
