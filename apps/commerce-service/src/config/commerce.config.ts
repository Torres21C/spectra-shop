import {
  identityPublicKeySource,
  readIdentityPublicKeyPem,
} from '../common/identity-public-key.js';

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

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} debe ser un entero entre ${min} y ${max}`);
  }
  return value;
}

export const commerceConfig = {
  catalogUrl: internalUrl('CATALOG_INTERNAL_URL', 'http://catalog-service:3002'),
  identityUrl: internalUrl('IDENTITY_INTERNAL_URL', 'http://identity-service:3001'),
  internalToken: required('SPECTRA_INTERNAL_TOKEN'),
  /** Token de alcance de inventario (M04); distinto del token compartido de lectura. */
  inventoryToken: (() => {
    const token = required('CATALOG_INVENTORY_TOKEN');
    if (token.length < 32 || token === process.env.SPECTRA_INTERNAL_TOKEN?.trim()) {
      throw new Error(
        'CATALOG_INVENTORY_TOKEN debe tener 32+ caracteres y diferir del token compartido',
      );
    }
    return token;
  })(),
  /** AD-08: se valida al arrancar; PEM en IDENTITY_PUBLIC_KEY_PEM (AWS) o archivo (local). */
  identityPublicKey: identityPublicKeySource(),
  issuer: process.env.JWT_ISSUER ?? 'spectra-shop-identity',
  audience: process.env.JWT_AUDIENCE ?? 'spectra-shop-services',
  cookieSecure: booleanEnv('COOKIE_SECURE', process.env.NODE_ENV === 'production'),
  timeoutMs,
  /** Duración del arrendamiento de un intento de checkout por un proceso Commerce. */
  checkoutLeaseMs: integerEnv('CHECKOUT_LEASE_MS', 30_000, 1_000, 300_000),
  /** Intervalo del reconciliador de sagas; 0 lo limita al arranque. */
  recoveryIntervalMs: integerEnv('CHECKOUT_RECOVERY_INTERVAL_MS', 15_000, 0, 600_000),
  recoveryBatchSize: 20,
  /** M04.1: backoff exponencial del reconciliador (base y tope) tras un intento fallido. */
  recoveryBackoffBaseMs: integerEnv('CHECKOUT_RECOVERY_BACKOFF_BASE_MS', 15_000, 10, 600_000),
  recoveryBackoffMaxMs: integerEnv('CHECKOUT_RECOVERY_BACKOFF_MAX_MS', 900_000, 10, 86_400_000),
  /** M04.1: una saga en curso se declara atascada por antigüedad o por número de reintentos. */
  stuckAgeMs: integerEnv('CHECKOUT_STUCK_AGE_MS', 300_000, 10, 86_400_000),
  stuckAttempts: integerEnv('CHECKOUT_STUCK_ATTEMPTS', 5, 1, 1_000),
  /** DT-08: reconciliador del reconocimiento de entrega (FULFILLED); 0 lo limita al arranque. */
  fulfillmentIntervalMs: integerEnv('FULFILLMENT_RECOVERY_INTERVAL_MS', 15_000, 0, 600_000),
  fulfillmentBatchSize: 20,
  /** DT-08: arrendamiento por intento de reconocimiento (varias réplicas compiten por él). */
  fulfillmentLeaseMs: integerEnv('FULFILLMENT_LEASE_MS', 30_000, 1_000, 300_000),
  /** DT-08: backoff exponencial acotado de los reintentos (15 s, 30 s, 60 s… hasta 15 min). */
  fulfillmentBackoffBaseMs: integerEnv('FULFILLMENT_RETRY_BASE_MS', 15_000, 10, 600_000),
  fulfillmentBackoffMaxMs: integerEnv('FULFILLMENT_RETRY_MAX_MS', 900_000, 10, 86_400_000),
  /** DT-08: el reconocimiento se declara atascado por reintentos o por antigüedad del pedido. */
  fulfillmentStuckAttempts: integerEnv('FULFILLMENT_STUCK_ATTEMPTS', 5, 1, 1_000),
  fulfillmentStuckAgeMs: integerEnv('FULFILLMENT_STUCK_AGE_MS', 300_000, 10, 86_400_000),
  /** Espera máxima de una petición duplicada concurrente antes de responder 409 en curso. */
  duplicateWaitMs: integerEnv('CHECKOUT_DUPLICATE_WAIT_MS', 5_000, 0, 30_000),
  /** RS10: intentos nuevos de checkout por cuenta y minuto. */
  checkoutAttemptsPerMinute: integerEnv('CHECKOUT_ATTEMPTS_PER_MINUTE', 10, 1, 120),
  idempotencyTtlMs: 24 * 60 * 60 * 1000,
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
  return readIdentityPublicKeyPem();
}
