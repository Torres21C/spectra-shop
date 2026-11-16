import { readFile } from 'node:fs/promises';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} es obligatorio`);
  return value;
}

function internalUrl(name: string, fallback: string): URL {
  const url = new URL(process.env[name] ?? fallback);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${name} debe ser una URL HTTP(S) sin credenciales`);
  }
  return url;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} debe ser true o false`);
}

const timeoutMs = Number.parseInt(process.env.INTERNAL_HTTP_TIMEOUT_MS ?? '1500', 10);
if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5000) {
  throw new Error('INTERNAL_HTTP_TIMEOUT_MS debe estar entre 100 y 5000');
}

export const commerceConfig = {
  catalogUrl: internalUrl('CATALOG_INTERNAL_URL', 'http://catalog-service:3002'),
  identityUrl: internalUrl('IDENTITY_INTERNAL_URL', 'http://identity-service:3001'),
  internalToken: required('SPECTRA_INTERNAL_TOKEN'),
  publicKeyPath: required('IDENTITY_PUBLIC_KEY_PATH'),
  issuer: process.env.JWT_ISSUER ?? 'spectra-shop-identity',
  audience: process.env.JWT_AUDIENCE ?? 'spectra-shop-services',
  cookieSecure: booleanEnv('COOKIE_SECURE', process.env.NODE_ENV === 'production'),
  timeoutMs,
  allowedOrigins: new Set(
    (process.env.CORS_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  ),
};

export function accessCookieName(): string {
  return commerceConfig.cookieSecure ? '__Host-spectra-access' : 'spectra-access-dev';
}

export function csrfCookieName(): string {
  return commerceConfig.cookieSecure ? '__Host-spectra-csrf' : 'spectra-csrf-dev';
}

export function readIdentityPublicKey(): Promise<string> {
  return readFile(commerceConfig.publicKeyPath, 'utf8');
}
