import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { ValidatedSession } from '@spectra/contracts';
import { importSPKI, jwtVerify, type CryptoKey } from 'jose';
import { adminConfig } from './admin.config.js';

/** Verificación local del JWT ES256 emitido por Identity (mismo contrato que Commerce). */
@Injectable()
export class JwtVerifierService {
  private publicKey: Promise<CryptoKey> | undefined;

  async verify(token: string): Promise<ValidatedSession> {
    try {
      this.publicKey ??= adminConfig
        .readIdentityPublicKey()
        .then((pem) => importSPKI(pem, 'ES256'));
      const { payload } = await jwtVerify(token, await this.publicKey, {
        algorithms: ['ES256'],
        issuer: adminConfig.issuer(),
        audience: adminConfig.audience(),
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
      throw new UnauthorizedException({
        code: 'AUTH_REQUIRED',
        message: 'Autenticación requerida',
      });
    }
  }
}
