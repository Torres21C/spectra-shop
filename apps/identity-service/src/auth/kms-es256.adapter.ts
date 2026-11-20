import { createPublicKey, randomUUID, verify, type KeyObject } from 'node:crypto';
import type { OnModuleInit } from '@nestjs/common';
import { base64url, calculateJwkThumbprint, exportJWK, jwtVerify } from 'jose';
import { identityConfig } from '../config/identity.config.js';
import { derToJoseSignature } from './ecdsa-der.js';
import type { AccessClaims, JwtCryptoPort } from './jwt-crypto.port.js';

/** Límite de KMS para `MessageType: RAW`. Un JWT de acceso de SPECTRA ocupa unos 350 bytes. */
const KMS_RAW_MESSAGE_LIMIT = 4096;
const SELF_TEST_MESSAGE = Buffer.from('spectra-shop:kms-es256:self-test', 'utf8');

export interface KmsPublicKey {
  /** SubjectPublicKeyInfo en DER, tal como lo devuelve `GetPublicKey`. */
  readonly spkiDer: Uint8Array;
  readonly keySpec: string | undefined;
  readonly keyUsage: string | undefined;
  readonly signingAlgorithms: readonly string[];
}

/** Operaciones de KMS que necesita Identity. Permite probar el adaptador sin AWS. */
export interface KmsSigningClient {
  getPublicKey(keyId: string): Promise<KmsPublicKey>;
  /** Firma ECDSA_SHA_256 de `message` (KMS calcula el SHA-256); devuelve la firma en DER. */
  sign(keyId: string, message: Uint8Array): Promise<Uint8Array>;
}

/**
 * AD-08 / AWS-01: firma los JWT de acceso con una clave asimétrica `ECC_NIST_P256` de AWS KMS. La clave
 * privada nunca sale de KMS. La verificación es local con la clave pública obtenida al arrancar, sin
 * llamar a KMS en cada petición. Mismos claims que `DevelopmentEs256Adapter`.
 */
export class KmsEs256Adapter implements JwtCryptoPort, OnModuleInit {
  private publicKey!: KeyObject;
  private kid!: string;

  constructor(
    private readonly kms: KmsSigningClient,
    private readonly keyId: string,
  ) {}

  async onModuleInit(): Promise<void> {
    const key = await this.kms.getPublicKey(this.keyId);
    if (
      key.keySpec !== 'ECC_NIST_P256' ||
      key.keyUsage !== 'SIGN_VERIFY' ||
      !key.signingAlgorithms.includes('ECDSA_SHA_256')
    ) {
      throw new Error('La clave KMS debe ser ECC_NIST_P256, SIGN_VERIFY y admitir ECDSA_SHA_256');
    }
    const publicKey = createPublicKey({
      key: Buffer.from(key.spkiDer),
      format: 'der',
      type: 'spki',
    });
    if (publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('La clave pública de KMS no es P-256');
    }
    this.publicKey = publicKey;
    this.kid = await calculateJwkThumbprint(await exportJWK(publicKey));

    // Falla cerrado al arrancar si el rol de la tarea no puede firmar o la firma no verifica.
    const probe = derToJoseSignature(await this.kms.sign(this.keyId, SELF_TEST_MESSAGE));
    const valid = verify(
      'sha256',
      SELF_TEST_MESSAGE,
      { key: this.publicKey, dsaEncoding: 'ieee-p1363' },
      probe,
    );
    if (!valid) throw new Error('La autoprueba de firma KMS no verificó con la clave pública');
  }

  async signAccess(userId: string, sessionId: string, role: 'CLIENTE' | 'ADMIN'): Promise<string> {
    const issuedAt = Math.floor(Date.now() / 1000);
    const header = { alg: 'ES256', typ: 'JWT', kid: this.kid };
    const payload = {
      role,
      sid: sessionId,
      sub: userId,
      jti: randomUUID(),
      iss: identityConfig.issuer,
      aud: identityConfig.audience,
      iat: issuedAt,
      exp: issuedAt + identityConfig.accessTtlSeconds,
    };
    const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
    const message = Buffer.from(signingInput, 'ascii');
    if (message.length > KMS_RAW_MESSAGE_LIMIT) throw new Error('JWT demasiado grande para KMS');
    const signature = derToJoseSignature(await this.kms.sign(this.keyId, message));
    return `${signingInput}.${base64url.encode(signature)}`;
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    const { payload } = await jwtVerify(token, this.publicKey, {
      algorithms: ['ES256'],
      issuer: identityConfig.issuer,
      audience: identityConfig.audience,
      clockTolerance: 5,
    });
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

function encodeSegment(value: object): string {
  return base64url.encode(JSON.stringify(value));
}
