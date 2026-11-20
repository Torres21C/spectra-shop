import { readFile } from 'node:fs/promises';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} debe ser true o false`);
}

export const identityConfig = {
  issuer: process.env.JWT_ISSUER ?? 'spectra-shop-identity',
  audience: process.env.JWT_AUDIENCE ?? 'spectra-shop-services',
  accessTtlSeconds: 15 * 60,
  inactivityMs: 30 * MINUTE,
  absoluteSessionMs: 8 * HOUR,
  lockWindowMs: 15 * MINUTE,
  lockDurationMs: 15 * MINUTE,
  cookieSecure: booleanEnv('COOKIE_SECURE', process.env.NODE_ENV === 'production'),
  allowedOrigins: new Set(
    (process.env.CORS_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  ),
};

/**
 * AD-08 / AWS-01: origen de la firma de los JWT. `file` (por defecto) usa claves PEM locales o efímeras;
 * `kms` firma con una clave asimétrica de AWS KMS indicada en IDENTITY_KMS_KEY_ID (ARN, id o alias).
 */
export function jwtSignerConfig(
  env: NodeJS.ProcessEnv = process.env,
): { readonly mode: 'file' } | { readonly mode: 'kms'; readonly keyId: string } {
  const mode = env.IDENTITY_JWT_SIGNER ?? 'file';
  if (mode === 'file') return { mode };
  if (mode !== 'kms') throw new Error('IDENTITY_JWT_SIGNER debe ser file o kms');
  const keyId = env.IDENTITY_KMS_KEY_ID?.trim();
  if (!keyId) throw new Error('IDENTITY_KMS_KEY_ID es obligatorio con IDENTITY_JWT_SIGNER=kms');
  return { mode, keyId };
}

export async function readDevelopmentKeys(): Promise<
  { privateKeyPem: string; publicKeyPem: string } | undefined
> {
  const privatePath = process.env.IDENTITY_PRIVATE_KEY_PATH;
  const publicPath = process.env.IDENTITY_PUBLIC_KEY_PATH;
  if (!privatePath && !publicPath) return undefined;
  if (!privatePath || !publicPath) {
    throw new Error('Deben definirse ambas rutas de claves ES256');
  }
  const [privateKeyPem, publicKeyPem] = await Promise.all([
    readFile(privatePath, 'utf8'),
    readFile(publicPath, 'utf8'),
  ]);
  return { privateKeyPem, publicKeyPem };
}

export function cookieNames(secure = identityConfig.cookieSecure) {
  return secure
    ? {
        access: '__Host-spectra-access',
        refresh: '__Host-spectra-refresh',
        csrf: '__Host-spectra-csrf',
      }
    : {
        access: 'spectra-access-dev',
        refresh: 'spectra-refresh-dev',
        csrf: 'spectra-csrf-dev',
      };
}
