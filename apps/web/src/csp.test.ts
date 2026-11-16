import { describe, expect, it } from 'vitest';
import indexHtml from '../index.html?raw';

/**
 * Regresión: la CSP de index.html omitía Commerce (:3003) en `connect-src`, por lo que en un
 * navegador real el carrito, el checkout y P07 no podían llamar a la API (detectado con Chrome
 * headless al capturar P07 en M05). Cada URL base por defecto de una API debe estar permitida.
 */
const sources = import.meta.glob<string>('./**/*-api.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

function connectSrc(): string[] {
  const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(indexHtml)?.[1];
  const directive = policy
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('connect-src '));
  return directive?.split(/\s+/).slice(1) ?? [];
}

describe('Content-Security-Policy of the web app', () => {
  it('allows every API origin the client calls by default (Identity, Catalog and Commerce)', () => {
    const defaults = Object.values(sources).flatMap((source) =>
      [...source.matchAll(/VITE_[A-Z_]+_API_URL \?\? '(http[^']+)'/g)].map((match) => match[1]!),
    );
    const origins = [...new Set(defaults.map((url) => new URL(url).origin))].sort();
    expect(origins).toEqual([
      'http://127.0.0.1:3001',
      'http://127.0.0.1:3002',
      'http://127.0.0.1:3003',
    ]);
    const allowed = connectSrc();
    for (const origin of origins) expect(allowed, origin).toContain(origin);
  });

  it('keeps the policy restrictive: no wildcards, inline scripts or eval', () => {
    expect(connectSrc()).not.toContain('*');
    expect(indexHtml).not.toMatch(/'unsafe-inline'|'unsafe-eval'/);
  });
});
