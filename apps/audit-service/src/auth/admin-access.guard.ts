import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ValidatedSession } from '@spectra/contracts';
import { importSPKI, jwtVerify, type CryptoKey } from 'jose';
import type { AuditRequest } from '../common/request-context.js';
import { auditConfig } from '../config.js';

const unauthenticated = () =>
  new UnauthorizedException({ code: 'AUTH_REQUIRED', message: 'Autenticación requerida' });

function isSession(value: unknown): value is ValidatedSession {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['userId'] === 'string' &&
    typeof record['sessionId'] === 'string' &&
    (record['role'] === 'CLIENTE' || record['role'] === 'ADMIN')
  );
}

/**
 * M07 mínimo: la consulta de auditoría exige JWT ES256 válido, sesión activa en Identity y rol ADMIN
 * (mismo contrato que Commerce y Catalog). JWT local y sesión validada deben coincidir.
 */
@Injectable()
export class AdminAccessGuard implements CanActivate {
  private publicKey: Promise<CryptoKey> | undefined;

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuditRequest>();
    const raw = request.cookies?.[auditConfig.accessCookieName()] as unknown;
    const token = typeof raw === 'string' ? raw : '';
    const local = await this.verify(token);
    const active = await this.validateAndTouch(token, request.requestId);
    if (
      local.userId !== active.userId ||
      local.sessionId !== active.sessionId ||
      local.role !== active.role
    ) {
      throw unauthenticated();
    }
    if (active.role !== 'ADMIN') {
      throw new ForbiddenException({ code: 'REQUEST_REJECTED', message: 'Solicitud rechazada' });
    }
    request.auth = active;
    return true;
  }

  private async verify(token: string): Promise<ValidatedSession> {
    try {
      this.publicKey ??= auditConfig
        .readIdentityPublicKey()
        .then((pem) => importSPKI(pem, 'ES256'));
      const { payload } = await jwtVerify(token, await this.publicKey, {
        algorithms: ['ES256'],
        issuer: auditConfig.issuer(),
        audience: auditConfig.audience(),
        clockTolerance: 5,
      });
      if (
        typeof payload.sub !== 'string' ||
        typeof payload.sid !== 'string' ||
        typeof payload.jti !== 'string' ||
        (payload.role !== 'CLIENTE' && payload.role !== 'ADMIN')
      ) {
        throw new Error('claims');
      }
      return { userId: payload.sub, sessionId: payload.sid, role: payload.role };
    } catch {
      throw unauthenticated();
    }
  }

  private async validateAndTouch(token: string, requestId: string): Promise<ValidatedSession> {
    let response: Response;
    try {
      response = await fetch(
        new URL('/internal/sessions/validate-touch', auditConfig.identityUrl()),
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(auditConfig.timeoutMs()),
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Spectra-Internal-Token': auditConfig.internalToken(),
            'X-Request-Id': requestId,
          },
        },
      );
    } catch {
      throw new ServiceUnavailableException({
        code: 'IDENTITY_UNAVAILABLE',
        message: 'Identidad no disponible',
      });
    }
    if (response.status === 401) throw unauthenticated();
    const payload: unknown = response.ok ? await response.json().catch(() => undefined) : undefined;
    if (!isSession(payload)) {
      throw new ServiceUnavailableException({
        code: 'IDENTITY_UNAVAILABLE',
        message: 'Identidad no disponible',
      });
    }
    return payload;
  }
}
