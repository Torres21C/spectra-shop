import { readIdentityPublicKeyPem } from './common/identity-public-key.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} es obligatorio`);
  return value;
}

function cookieSecure(): boolean {
  const raw = process.env.COOKIE_SECURE;
  if (raw === undefined) return process.env.NODE_ENV === 'production';
  if (raw !== 'true' && raw !== 'false') throw new Error('COOKIE_SECURE debe ser true o false');
  return raw === 'true';
}

/** Tokens de servicio aceptados para la ingesta interna (actual y, durante una rotación, anterior). */
export function readInternalTokens(): string[] {
  const tokens = (process.env.SPECTRA_INTERNAL_TOKENS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (tokens.length < 1 || tokens.length > 2 || tokens.some((value) => value.length < 32)) {
    throw new Error('SPECTRA_INTERNAL_TOKENS requiere uno o dos tokens de al menos 32 caracteres');
  }
  return tokens;
}

/** Configuración leída en diferido: las pruebas unitarias no necesitan el entorno completo. */
export const auditConfig = {
  identityUrl: (): URL =>
    new URL(process.env.IDENTITY_INTERNAL_URL ?? 'http://identity-service:3101'),
  internalToken: (): string => required('SPECTRA_INTERNAL_TOKEN'),
  issuer: (): string => process.env.JWT_ISSUER ?? 'spectra-shop-identity',
  audience: (): string => process.env.JWT_AUDIENCE ?? 'spectra-shop-services',
  timeoutMs: (): number => Number.parseInt(process.env.INTERNAL_HTTP_TIMEOUT_MS ?? '1500', 10),
  accessCookieName: (): string => (cookieSecure() ? '__Host-spectra-access' : 'spectra-access-dev'),
  /** AD-08: PEM en IDENTITY_PUBLIC_KEY_PEM (AWS) o archivo en IDENTITY_PUBLIC_KEY_PATH (local). */
  readIdentityPublicKey: (): Promise<string> => readIdentityPublicKeyPem(),
  allowedOrigins: (): ReadonlySet<string> =>
    new Set(
      (process.env.CORS_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
};
