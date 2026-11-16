import { randomUUID } from 'node:crypto';
import type { LoginResponse } from '@spectra/contracts';
import { importPKCS8, SignJWT } from 'jose';
import type { Pool } from 'pg';

export const ORIGIN = 'http://127.0.0.1:5173';
const ROLE_IDS = {
  CLIENTE: '10000000-0000-4000-8000-000000000001',
  ADMIN: '10000000-0000-4000-8000-000000000002',
} as const;

/** Comprador usado por las pruebas: cookies de sesión + token CSRF double-submit. */
export interface Buyer {
  readonly userId: string;
  cookieHeader(): string;
  csrf(): Promise<string>;
}

/** Cliente real: registro, login y CSRF emitidos por identity-service vía HTTP. */
export class IdentityAgent implements Buyer {
  readonly cookies = new Map<string, string>();
  userId = '';

  constructor(
    readonly email: string,
    readonly password: string,
  ) {}

  cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async csrf(): Promise<string> {
    const response = await this.identity('/auth/csrf');
    if (!response.ok) throw new Error('No fue posible emitir CSRF sintético');
    return ((await response.json()) as { csrfToken: string }).csrfToken;
  }

  async register(): Promise<void> {
    const token = await this.csrf();
    const response = await this.identity('/auth/register', {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify({
        fullName: 'Cliente sintético checkout',
        email: this.email,
        password: this.password,
        passwordConfirmation: this.password,
        academicDataAccepted: true,
      }),
    });
    if (response.status !== 201) throw new Error(`Registro sintético falló: ${response.status}`);
  }

  async login(): Promise<void> {
    const token = await this.csrf();
    const response = await this.identity('/auth/login', {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify({ email: this.email, password: this.password }),
    });
    if (response.status !== 201) throw new Error(`Login sintético falló: ${response.status}`);
    this.userId = ((await response.json()) as LoginResponse).user.id;
  }

  private headers(csrf: string): Record<string, string> {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Cookie: this.cookieHeader(),
      Origin: ORIGIN,
      'X-CSRF-Token': csrf,
    };
  }

  private async identity(path: string, init?: RequestInit): Promise<globalThis.Response> {
    const response = await fetch(`http://identity-service:3001${path}`, {
      redirect: 'error',
      ...init,
      headers: { Cookie: this.cookieHeader(), ...(init?.headers ?? {}) },
    });
    const getSetCookie = Reflect.get(response.headers, 'getSetCookie') as
      (() => string[]) | undefined;
    for (const header of getSetCookie?.call(response.headers) ?? []) {
      const [pair] = header.split(';', 1);
      const separator = pair?.indexOf('=') ?? -1;
      if (!pair || separator < 1) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (/Max-Age=0/i.test(header) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }
}

/**
 * Comprador provisionado directamente en el esquema identity (usuario + sesión activa) con un JWT
 * ES256 firmado con la clave de prueba. Evita el límite de registro por IP (RS10) en las pruebas de
 * concurrencia; cada petición sigue validándose contra identity-service real (validate-touch).
 */
export class SyntheticBuyer implements Buyer {
  private constructor(
    readonly userId: string,
    private readonly token: string,
    private readonly csrfValue: string,
    private readonly accessCookie: string,
    private readonly csrfCookie: string,
  ) {}

  static async provision(
    identityDb: Pool,
    privateKeyPem: string,
    cookieNames: { access: string; csrf: string },
    role: keyof typeof ROLE_IDS = 'CLIENTE',
  ): Promise<SyntheticBuyer> {
    const userId = randomUUID();
    const sessionId = randomUUID();
    await identityDb.query(
      `INSERT INTO identity.users
         (id, role_id, full_name, email_normalized, password_hash, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [
        userId,
        ROLE_IDS[role],
        'Comprador concurrente sintético',
        `concurrente.${userId.slice(0, 8)}@example.test`,
        'login-disabled-synthetic-buyer',
      ],
    );
    await identityDb.query(
      `INSERT INTO identity.auth_sessions (id, user_id, absolute_expires_at)
       VALUES ($1, $2, now() + interval '1 hour')`,
      [sessionId, userId],
    );
    const key = await importPKCS8(privateKeyPem, 'ES256');
    const token = await new SignJWT({ role, sid: sessionId })
      .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: 'spectra-dev-1' })
      .setSubject(userId)
      .setJti(randomUUID())
      .setIssuer('spectra-shop-identity')
      .setAudience('spectra-shop-services')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(key);
    return new SyntheticBuyer(userId, token, randomUUID(), cookieNames.access, cookieNames.csrf);
  }

  cookieHeader(): string {
    return `${this.accessCookie}=${this.token}; ${this.csrfCookie}=${this.csrfValue}`;
  }

  csrf(): Promise<string> {
    return Promise.resolve(this.csrfValue);
  }
}
