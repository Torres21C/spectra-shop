import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { ValidatedSession } from '@spectra/contracts';
import { adminConfig } from './admin.config.js';

function isSession(value: unknown): value is ValidatedSession {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['userId'] === 'string' &&
    typeof record['sessionId'] === 'string' &&
    (record['role'] === 'CLIENTE' || record['role'] === 'ADMIN')
  );
}

/** Valida en Identity que la sesión sigue activa (revocación, inactividad y expiración absoluta). */
@Injectable()
export class IdentityClientService {
  async validateAndTouch(token: string, requestId: string): Promise<ValidatedSession> {
    try {
      const response = await fetch(
        new URL('/internal/sessions/validate-touch', adminConfig.identityUrl()),
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(adminConfig.timeoutMs()),
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Spectra-Internal-Token': adminConfig.internalToken(),
            'X-Request-Id': requestId,
          },
        },
      );
      if (response.status === 401) throw new UnauthorizedException();
      if (!response.ok) throw new Error(`identity status ${response.status}`);
      const payload: unknown = await response.json();
      if (!isSession(payload)) throw new Error('identity response');
      return payload;
    } catch (error: unknown) {
      if (error instanceof UnauthorizedException) {
        throw new UnauthorizedException({
          code: 'AUTH_REQUIRED',
          message: 'Autenticación requerida',
        });
      }
      throw new ServiceUnavailableException({
        code: 'IDENTITY_UNAVAILABLE',
        message: 'Identidad no disponible',
      });
    }
  }
}
