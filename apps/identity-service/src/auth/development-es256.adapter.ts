import { randomUUID } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { SignJWT, generateKeyPair, importPKCS8, importSPKI, jwtVerify } from 'jose';
import { identityConfig, readDevelopmentKeys } from '../config/identity.config.js';
import type { AccessClaims, JwtCryptoPort } from './jwt-crypto.port.js';

@Injectable()
export class DevelopmentEs256Adapter implements JwtCryptoPort, OnModuleInit {
  private privateKey!: CryptoKey;
  private publicKey!: CryptoKey;

  async onModuleInit(): Promise<void> {
    const files = await readDevelopmentKeys();
    if (files) {
      this.privateKey = await importPKCS8(files.privateKeyPem, 'ES256');
      this.publicKey = await importSPKI(files.publicKeyPem, 'ES256');
      return;
    }
    if (process.env.IDENTITY_ALLOW_EPHEMERAL_KEYS !== 'true') {
      throw new Error('Configure claves ES256 fuera del repositorio');
    }
    const pair = await generateKeyPair('ES256', { extractable: false });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  async signAccess(userId: string, sessionId: string, role: 'CLIENTE' | 'ADMIN'): Promise<string> {
    return new SignJWT({ role, sid: sessionId })
      .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: 'spectra-dev-1' })
      .setSubject(userId)
      .setJti(randomUUID())
      .setIssuer(identityConfig.issuer)
      .setAudience(identityConfig.audience)
      .setIssuedAt()
      .setExpirationTime(`${identityConfig.accessTtlSeconds}s`)
      .sign(this.privateKey);
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    const verified = await jwtVerify(token, this.publicKey, {
      algorithms: ['ES256'],
      issuer: identityConfig.issuer,
      audience: identityConfig.audience,
      clockTolerance: 5,
    });
    const { payload } = verified;
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.sid !== 'string' ||
      typeof payload.jti !== 'string' ||
      (payload.role !== 'CLIENTE' && payload.role !== 'ADMIN')
    ) {
      throw new Error('JWT claims inválidos');
    }
    return payload as AccessClaims;
  }
}
