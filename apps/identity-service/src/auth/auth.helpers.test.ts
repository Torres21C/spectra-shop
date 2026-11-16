import { describe, expect, it } from 'vitest';
import { authCookieOptions } from './cookie.service.js';
import { safeReturnTo } from './auth.service.js';

describe('identity security helpers', () => {
  it('CA-M02-07 requires the production cookie policy', () => {
    expect(authCookieOptions(true, 900_000)).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
    });
  });

  it('CA-M02-09 accepts only internal return destinations', () => {
    expect(safeReturnTo('#/pedidos')).toBe('#/pedidos');
    expect(safeReturnTo('//sitio-externo.test')).toBe('#/');
    expect(safeReturnTo('https://sitio-externo.test')).toBe('#/');
    expect(safeReturnTo('/\\sitio-externo.test')).toBe('#/');
  });
});
