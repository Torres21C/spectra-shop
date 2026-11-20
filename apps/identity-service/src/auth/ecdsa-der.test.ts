import { generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { derToJoseSignature } from './ecdsa-der.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

describe('derToJoseSignature (AD-08, firma KMS → JWS ES256)', () => {
  it('converts real DER signatures to verifiable 64-byte R||S, including short and high-bit components', () => {
    let shortComponents = 0;
    let highBitComponents = 0;
    for (let i = 0; i < 2000; i += 1) {
      const message = randomBytes(48);
      const der = sign('sha256', message, { key: privateKey, dsaEncoding: 'der' });
      const rLength = der[3]!;
      const sLength = der[5 + rLength]!;
      if (rLength < 32 || sLength < 32) shortComponents += 1;
      if (rLength === 33 || sLength === 33) highBitComponents += 1;

      const jose = derToJoseSignature(der);
      expect(jose).toHaveLength(64);
      expect(verify('sha256', message, { key: publicKey, dsaEncoding: 'ieee-p1363' }, jose)).toBe(
        true,
      );
    }
    // 2000 firmas cubren con holgura ambos casos límite de la codificación DER.
    expect(shortComponents).toBeGreaterThan(0);
    expect(highBitComponents).toBeGreaterThan(0);
  });

  it('rejects malformed DER', () => {
    const der = sign('sha256', Buffer.from('x'), { key: privateKey, dsaEncoding: 'der' });
    const cases: Uint8Array[] = [
      new Uint8Array(),
      Uint8Array.from([0x31, ...der.subarray(1)]), // etiqueta distinta de SEQUENCE
      Uint8Array.from([...der, 0x00]), // bytes sobrantes
      der.subarray(0, der.length - 1), // truncada
      Uint8Array.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x03, 0x01, 0x01]), // segundo elemento no INTEGER
      Uint8Array.from([0x30, 0x26, 0x02, 0x21, ...new Uint8Array(33).fill(0x7f), 0x02, 0x01, 0x01]), // r > 32 bytes
    ];
    for (const value of cases) expect(() => derToJoseSignature(value)).toThrow('Firma ECDSA DER');
  });
});
