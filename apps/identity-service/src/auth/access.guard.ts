import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { IdentityRequest } from '../common/request-context.js';
import { CookieService } from './cookie.service.js';
import { AuthException } from '../common/auth.exception.js';
import { AuthService } from './auth.service.js';

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly cookies: CookieService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<IdentityRequest>();
    const token = request.cookies?.[this.cookies.names.access] as unknown;
    if (typeof token !== 'string') {
      throw new AuthException(401, 'AUTH_REQUIRED', 'Autenticación requerida');
    }
    request.auth = await this.auth.authenticate(token);
    return true;
  }
}
