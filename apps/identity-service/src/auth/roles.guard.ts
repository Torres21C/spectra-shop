import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { IdentityRequest } from '../common/request-context.js';

export const Roles = (...roles: Array<'CLIENTE' | 'ADMIN'>) => SetMetadata('roles', roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Array<'CLIENTE' | 'ADMIN'>>('roles', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles?.length) return true;
    const request = context.switchToHttp().getRequest<IdentityRequest>();
    return request.auth !== undefined && roles.includes(request.auth.role);
  }
}
