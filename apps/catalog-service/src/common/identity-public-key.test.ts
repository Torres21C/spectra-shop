import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { identityPublicKeySource, readIdentityPublicKeyPem } from './identity-public-key.js';

const PEM = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .publicKey.export({ format: 'pem', type: 'spki' })
  .toString();

describe('clave pública de Identity (AD-08)', () => {
  it('reads the key from IDENTITY_PUBLIC_KEY_PEM, with real or escaped newlines', async () => {
    await expect(readIdentityPublicKeyPem({ IDENTITY_PUBLIC_KEY_PEM: PEM })).resolves.toBe(
      PEM.trim(),
    );
    const escaped = PEM.trim().replace(/\n/g, '\\n');
    await expect(readIdentityPublicKeyPem({ IDENTITY_PUBLIC_KEY_PEM: escaped })).resolves.toBe(
      PEM.trim(),
    );
  });

  it('keeps reading the key from IDENTITY_PUBLIC_KEY_PATH (local development)', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'spectra-key-')), 'public.pem');
    await writeFile(path, PEM);
    await expect(readIdentityPublicKeyPem({ IDENTITY_PUBLIC_KEY_PATH: path })).resolves.toBe(PEM);
  });

  it('requires exactly one valid source', () => {
    expect(() => identityPublicKeySource({})).toThrow('obligatorio');
    expect(() =>
      identityPublicKeySource({ IDENTITY_PUBLIC_KEY_PEM: PEM, IDENTITY_PUBLIC_KEY_PATH: '/k.pem' }),
    ).toThrow('solo una');
    expect(() => identityPublicKeySource({ IDENTITY_PUBLIC_KEY_PEM: 'no-es-pem' })).toThrow('PEM');
  });
});
