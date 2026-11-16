import type { JWTPayload } from 'jose';

export const JWT_CRYPTO_PORT = Symbol('JWT_CRYPTO_PORT');

export interface AccessClaims extends JWTPayload {
  sub: string;
  sid: string;
  role: 'CLIENTE' | 'ADMIN';
  jti: string;
}

/** Puerto sustituible por un adaptador AWS KMS sin cambiar el dominio de autenticación. */
export interface JwtCryptoPort {
  signAccess(userId: string, sessionId: string, role: 'CLIENTE' | 'ADMIN'): Promise<string>;
  verifyAccess(token: string): Promise<AccessClaims>;
}
