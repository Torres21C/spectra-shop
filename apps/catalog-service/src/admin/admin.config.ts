import { readIdentityPublicKeyPem } from '../common/identity-public-key.js';

/**
 * M06/M07 mínimo: configuración de la administración de Catalog y del relay de auditoría.
 * Se lee en diferido para que las suites que no usan administración no exijan estas variables;
 * la primera petición administrativa o el relay fallan cerrados si falta algo.
 */
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} es obligatorio para la administración de Catalog`);
  return value;
}

function url(name: string, fallback: string): URL {
  const parsed = new URL(process.env[name] ?? fallback);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} debe usar http o https`);
  }
  return parsed;
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} debe ser un entero entre ${min} y ${max}`);
  }
  return value;
}

function cookieSecure(): boolean {
  const raw = process.env.COOKIE_SECURE;
  if (raw === undefined) return process.env.NODE_ENV === 'production';
  if (raw !== 'true' && raw !== 'false') throw new Error('COOKIE_SECURE debe ser true o false');
  return raw === 'true';
}

export const adminConfig = {
  identityUrl: (): URL => url('IDENTITY_INTERNAL_URL', 'http://identity-service:3101'),
  internalToken: (): string => {
    const token = required('SPECTRA_INTERNAL_TOKEN');
    if (token.length < 32)
      throw new Error('SPECTRA_INTERNAL_TOKEN requiere al menos 32 caracteres');
    return token;
  },
  issuer: (): string => process.env.JWT_ISSUER ?? 'spectra-shop-identity',
  audience: (): string => process.env.JWT_AUDIENCE ?? 'spectra-shop-services',
  timeoutMs: (): number => integer('INTERNAL_HTTP_TIMEOUT_MS', 1500, 100, 5000),
  allowedOrigins: (): ReadonlySet<string> =>
    new Set(
      (process.env.CORS_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  accessCookieName: (): string => (cookieSecure() ? '__Host-spectra-access' : 'spectra-access-dev'),
  csrfCookieName: (): string => (cookieSecure() ? '__Host-spectra-csrf' : 'spectra-csrf-dev'),
  /** AD-08: PEM en IDENTITY_PUBLIC_KEY_PEM (AWS) o archivo en IDENTITY_PUBLIC_KEY_PATH (local). */
  readIdentityPublicKey: (): Promise<string> => readIdentityPublicKeyPem(),
  auditUrl: (): URL => url('AUDIT_INTERNAL_URL', 'http://audit-service:3104'),
  /** 0 desactiva el temporizador (pruebas); el relay sigue disponible con `runOnce`. */
  relayIntervalMs: (): number => integer('AUDIT_RELAY_INTERVAL_MS', 5000, 0, 600_000),
  relayBatchSize: (): number => integer('AUDIT_RELAY_BATCH_SIZE', 50, 1, 100),
};
