import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { decodeProtectedHeader, jwtVerify } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { identityConfig, jwtSignerConfig } from '../config/identity.config.js';
import { jwtCryptoProvider } from './auth.module.js';
import { DevelopmentEs256Adapter } from './development-es256.adapter.js';
import { JWT_CRYPTO_PORT, type JwtCryptoPort } from './jwt-crypto.port.js';
import { KmsEs256Adapter, type KmsPublicKey, type KmsSigningClient } from './kms-es256.adapter.js';

const KEY_ID = 'alias/spectra-jwt';

/** KMS simulado: firma ECDSA_SHA_256 con una clave P-256 real y devuelve DER, como AWS KMS. */
function fakeKms(overrides: Partial<KmsPublicKey> = {}, signingKey?: KeyObject) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const calls = { sign: 0 };
  const client: KmsSigningClient = {
    getPublicKey: vi.fn((keyId: string) => {
      expect(keyId).toBe(KEY_ID);
      return Promise.resolve({
        spkiDer: pair.publicKey.export({ format: 'der', type: 'spki' }),
        keySpec: 'ECC_NIST_P256',
        keyUsage: 'SIGN_VERIFY',
        signingAlgorithms: ['ECDSA_SHA_256'],
        ...overrides,
      });
    }),
    sign: vi.fn((keyId: string, message: Uint8Array) => {
      expect(keyId).toBe(KEY_ID);
      calls.sign += 1;
      return Promise.resolve(
        sign('sha256', message, { key: signingKey ?? pair.privateKey, dsaEncoding: 'der' }),
      );
    }),
  };
  return { client, publicKey: pair.publicKey, calls };
}

describe('KmsEs256Adapter (AD-08)', () => {
  it('issues ES256 access tokens verifiable with the KMS public key and the same claims', async () => {
    const kms = fakeKms();
    const adapter = new KmsEs256Adapter(kms.client, KEY_ID);
    await adapter.onModuleInit();

    const token = await adapter.signAccess('user-1', 'session-1', 'ADMIN');
    const header = decodeProtectedHeader(token);
    expect(header).toMatchObject({ alg: 'ES256', typ: 'JWT' });
    expect(header.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Lo verifica cualquier consumidor con la clave pública (Catalog, Commerce, Audit).
    const { payload } = await jwtVerify(token, kms.publicKey, {
      algorithms: ['ES256'],
      issuer: identityConfig.issuer,
      audience: identityConfig.audience,
    });
    expect(payload).toMatchObject({ sub: 'user-1', sid: 'session-1', role: 'ADMIN' });
    expect(payload.exp! - payload.iat!).toBe(identityConfig.accessTtlSeconds);
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);

    await expect(adapter.verifyAccess(token)).resolves.toMatchObject({ sub: 'user-1' });
  });

  it('verifies locally without calling KMS and rejects tampered tokens', async () => {
    const kms = fakeKms();
    const adapter = new KmsEs256Adapter(kms.client, KEY_ID);
    await adapter.onModuleInit();
    const token = await adapter.signAccess('user-1', 'session-1', 'CLIENTE');
    const signsAfterIssuing = kms.calls.sign;

    await adapter.verifyAccess(token);
    expect(kms.calls.sign).toBe(signsAfterIssuing);

    const [header, payload, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ role: 'ADMIN', sid: 's', sub: 'u', jti: 'j' }));
    await expect(
      adapter.verifyAccess(`${header}.${forged.toString('base64url')}.${signature}`),
    ).rejects.toThrow();
    await expect(adapter.verifyAccess(`${header}.${payload}.${'A'.repeat(86)}`)).rejects.toThrow();
  });

  it('refuses keys that are not ECC_NIST_P256 SIGN_VERIFY with ECDSA_SHA_256', async () => {
    for (const overrides of [
      { keySpec: 'RSA_2048' },
      { keyUsage: 'ENCRYPT_DECRYPT' },
      { signingAlgorithms: ['ECDSA_SHA_384'] },
    ]) {
      const adapter = new KmsEs256Adapter(fakeKms(overrides).client, KEY_ID);
      await expect(adapter.onModuleInit()).rejects.toThrow('ECC_NIST_P256');
    }
  });

  it('fails closed at startup when the KMS signature does not match the public key', async () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const adapter = new KmsEs256Adapter(fakeKms({}, other).client, KEY_ID);
    await expect(adapter.onModuleInit()).rejects.toThrow('autoprueba');
  });

  it('runs onModuleInit when Nest builds the adapter from a factory provider', async () => {
    const kms = fakeKms();
    @Module({
      providers: [
        { provide: JWT_CRYPTO_PORT, useFactory: () => new KmsEs256Adapter(kms.client, KEY_ID) },
      ],
    })
    class ProbeModule {}
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    await moduleRef.init();
    const port = moduleRef.get<JwtCryptoPort>(JWT_CRYPTO_PORT);
    await expect(port.signAccess('u', 's', 'CLIENTE')).resolves.toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    await moduleRef.close();
  });
});

describe('selección del firmante JWT', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to local keys and requires a key id for KMS', () => {
    expect(jwtSignerConfig({})).toEqual({ mode: 'file' });
    expect(jwtSignerConfig({ IDENTITY_JWT_SIGNER: 'kms', IDENTITY_KMS_KEY_ID: KEY_ID })).toEqual({
      mode: 'kms',
      keyId: KEY_ID,
    });
    expect(() => jwtSignerConfig({ IDENTITY_JWT_SIGNER: 'kms' })).toThrow('IDENTITY_KMS_KEY_ID');
    expect(() => jwtSignerConfig({ IDENTITY_JWT_SIGNER: 'hsm' })).toThrow('file o kms');
  });

  it('wires the KMS adapter only when IDENTITY_JWT_SIGNER=kms', () => {
    const factory = (jwtCryptoProvider as { useFactory: () => JwtCryptoPort }).useFactory;
    vi.stubEnv('IDENTITY_JWT_SIGNER', 'kms');
    vi.stubEnv('IDENTITY_KMS_KEY_ID', KEY_ID);
    vi.stubEnv('AWS_REGION', 'us-east-1');
    expect(factory()).toBeInstanceOf(KmsEs256Adapter);
    vi.stubEnv('IDENTITY_JWT_SIGNER', 'file');
    expect(factory()).toBeInstanceOf(DevelopmentEs256Adapter);
  });
});
