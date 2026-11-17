import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AdminAccessGuard, assertCsrf, type AdminRequest } from './admin-access.guard.js';
import { adminConfig } from './admin.config.js';
import type { IdentityClientService } from './identity-client.service.js';
import type { JwtVerifierService } from './jwt-verifier.service.js';

const ADMIN = { userId: 'u-1', sessionId: 's-1', role: 'ADMIN' as const };
// Los nombres de cookie y el origen dependen de COOKIE_SECURE y CORS_ORIGINS (p. ej. la CI usa __Host-).
const ACCESS = adminConfig.accessCookieName();
const CSRF_COOKIE = adminConfig.csrfCookieName();
const ALLOWED_ORIGIN = [...adminConfig.allowedOrigins()][0]!;

function context(request: Partial<AdminRequest>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function guard(local: unknown, active: unknown) {
  const jwt = {
    verify: vi.fn((token: string) =>
      token === '' ? Promise.reject(new UnauthorizedException()) : Promise.resolve(local),
    ),
  } as unknown as JwtVerifierService;
  const identity = {
    validateAndTouch: vi.fn(() => Promise.resolve(active)),
  } as unknown as IdentityClientService;
  return new AdminAccessGuard(jwt, identity);
}

describe('AdminAccessGuard (M06 mínimo)', () => {
  const request = () => ({ cookies: { [ACCESS]: 'jwt' }, requestId: 'r-1' });

  it('admits an ADMIN whose JWT and active session match', async () => {
    const req: Partial<AdminRequest> = request();
    await expect(guard(ADMIN, ADMIN).canActivate(context(req))).resolves.toBe(true);
    expect(req.auth).toEqual(ADMIN);
  });

  it('rejects a CLIENTE with 403', async () => {
    const client = { ...ADMIN, role: 'CLIENTE' as const };
    await expect(guard(client, client).canActivate(context(request()))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('treats a JWT/session mismatch (e.g. role changed) as unauthenticated', async () => {
    await expect(
      guard(ADMIN, { ...ADMIN, role: 'CLIENTE' }).canActivate(context(request())),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('requires a session cookie', async () => {
    await expect(
      guard(ADMIN, ADMIN).canActivate(context({ cookies: {}, requestId: 'r-1' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('assertCsrf (M06 mínimo)', () => {
  const base = (headers: Record<string, string>, csrf?: string) =>
    ({
      header: (name: string) => headers[name.toLowerCase()],
      cookies: csrf ? { [CSRF_COOKIE]: csrf } : {},
    }) as unknown as AdminRequest;

  it('accepts a matching token from an allowed Origin', () => {
    expect(() =>
      assertCsrf(base({ origin: ALLOWED_ORIGIN, 'x-csrf-token': 'abc' }, 'abc')),
    ).not.toThrow();
  });

  it.each([
    ['a foreign origin', base({ origin: 'https://evil.example', 'x-csrf-token': 'abc' }, 'abc')],
    ['a missing origin', base({ 'x-csrf-token': 'abc' }, 'abc')],
    ['a missing header', base({ origin: ALLOWED_ORIGIN }, 'abc')],
    ['a missing cookie', base({ origin: ALLOWED_ORIGIN, 'x-csrf-token': 'abc' })],
    ['a mismatching token', base({ origin: ALLOWED_ORIGIN, 'x-csrf-token': 'abd' }, 'abc')],
  ])('rejects %s', (_label, request) => {
    expect(() => assertCsrf(request)).toThrow(ForbiddenException);
  });
});
