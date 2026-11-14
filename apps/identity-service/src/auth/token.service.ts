import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { JWT_CRYPTO_PORT, type AccessClaims, type JwtCryptoPort } from './jwt-crypto.port.js';

@Injectable()
export class TokenService {
  constructor(@Inject(JWT_CRYPTO_PORT) private readonly jwt: JwtCryptoPort) {}

  signAccess(userId: string, sessionId: string, role: 'CLIENTE' | 'ADMIN'): Promise<string> {
    return this.jwt.signAccess(userId, sessionId, role);
  }

  verifyAccess(token: string): Promise<AccessClaims> {
    return this.jwt.verifyAccess(token);
  }

  newRefreshToken(): string {
    return randomBytes(32).toString('base64url');
  }

  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }
}
