import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { ValidatedSession } from '@spectra/contracts';
import { commerceConfig } from '../config/commerce.config.js';

function isSession(value: unknown): value is ValidatedSession {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const userId = record['userId'];
  const sessionId = record['sessionId'];
  const role = record['role'];
  return (
    typeof userId === 'string' &&
    typeof sessionId === 'string' &&
    (role === 'CLIENTE' || role === 'ADMIN')
  );
}

@Injectable()
export class IdentityClientService {
  async validateAndTouch(token: string, requestId: string): Promise<ValidatedSession> {
    const url = new URL('/internal/sessions/validate-touch', commerceConfig.identityUrl);
    try {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(commerceConfig.timeoutMs),
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Spectra-Internal-Token': commerceConfig.internalToken,
          'X-Request-Id': requestId,
        },
      });
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
