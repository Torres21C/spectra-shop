import { Injectable, type OnModuleInit, UnauthorizedException } from '@nestjs/common';
import type { ValidatedSession } from '@spectra/contracts';
import { importSPKI, jwtVerify, type CryptoKey } from 'jose';
import { commerceConfig, readIdentityPublicKey } from '../config/commerce.config.js';

@Injectable()
export class JwtVerifierService implements OnModuleInit {
  private publicKey!: CryptoKey;

  async onModuleInit(): Promise<void> {
    this.publicKey = await importSPKI(await readIdentityPublicKey(), 'ES256');
  }

  async verify(token: string): Promise<ValidatedSession> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        algorithms: ['ES256'],
        issuer: commerceConfig.issuer,
        audience: commerceConfig.audience,
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
