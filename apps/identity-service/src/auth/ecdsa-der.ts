/**
 * AD-08 / AWS-01: AWS KMS devuelve las firmas ECDSA codificadas en DER
 * (`SEQUENCE { INTEGER r, INTEGER s }`), mientras que JWS ES256 (RFC 7518 §3.4) exige la
 * concatenación `R || S` de longitud fija (32 + 32 bytes en P-256).
 */
export function derToJoseSignature(der: Uint8Array, componentSize = 32): Buffer {
  let offset = 0;
  const byte = (): number => {
    const value = der[offset++];
    if (value === undefined) throw invalidSignature();
    return value;
  };

  if (byte() !== 0x30) throw invalidSignature();
  let sequenceLength = byte();
  if (sequenceLength === 0x81) sequenceLength = byte();
  else if (sequenceLength > 0x7f) throw invalidSignature();
  if (offset + sequenceLength !== der.length) throw invalidSignature();

  const integer = (): Buffer => {
    if (byte() !== 0x02) throw invalidSignature();
    const length = byte();
    if (length === 0 || length > 0x7f || offset + length > der.length) throw invalidSignature();
    let value = der.subarray(offset, offset + length);
    offset += length;
    // DER añade un 0x00 inicial cuando el bit alto está activo; se descartan los ceros a la izquierda.
    while (value.length > 1 && value[0] === 0) value = value.subarray(1);
    if (value.length > componentSize) throw invalidSignature();
    const padded = Buffer.alloc(componentSize);
    padded.set(value, componentSize - value.length);
    return padded;
  };

  const r = integer();
  const s = integer();
  if (offset !== der.length) throw invalidSignature();
  return Buffer.concat([r, s]);
}

function invalidSignature(): Error {
  return new Error('Firma ECDSA DER inválida');
}
