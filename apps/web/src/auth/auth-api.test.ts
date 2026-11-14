import { describe, expect, it } from 'vitest';
import { safeClientReturn } from './auth-api.js';

describe('auth client security', () => {
  it('CA-M02-09 refuses external navigation targets', () => {
    expect(safeClientReturn('#/pedidos')).toBe('#/pedidos');
    expect(safeClientReturn('//sitio-externo.test')).toBe('#/');
    expect(safeClientReturn('https://sitio-externo.test')).toBe('#/');
  });
});
