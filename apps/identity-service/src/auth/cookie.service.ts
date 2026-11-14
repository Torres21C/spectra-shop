import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { cookieNames, identityConfig } from '../config/identity.config.js';

const ACCESS_MAX_AGE = 15 * 60_000;
const REFRESH_MAX_AGE = 8 * 60 * 60_000;

export function authCookieOptions(secure: boolean, maxAge: number) {
  return { httpOnly: true, secure, sameSite: 'strict' as const, path: '/', maxAge };
}

@Injectable()
export class CookieService {
  readonly names = cookieNames();

  setSession(response: Response, accessToken: string, refreshToken: string): void {
    this.setCookie(response, this.names.access, accessToken, ACCESS_MAX_AGE);
    this.setCookie(response, this.names.refresh, refreshToken, REFRESH_MAX_AGE);
  }

  setCsrf(response: Response, token: string): void {
    this.setCookie(response, this.names.csrf, token, 60 * 60_000);
  }

  clearSession(response: Response): void {
    const options = authCookieOptions(identityConfig.cookieSecure, 0);
    response.clearCookie(this.names.access, options);
    response.clearCookie(this.names.refresh, options);
  }

  private setCookie(response: Response, name: string, value: string, maxAge: number): void {
    // Semgrep: secure is environment-bound; production is asserted by cookie-policy tests.
    // nosemgrep: spectra-cookie-without-secure
    response.cookie(name, value, {
      httpOnly: true,
      secure: identityConfig.cookieSecure,
      sameSite: 'strict',
      path: '/',
      maxAge,
    });
  }
}
