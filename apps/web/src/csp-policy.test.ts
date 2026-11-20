import { describe, expect, it } from 'vitest';
import indexHtml from '../index.html?raw';
import { API_URL_DEFAULTS, productionConnectSrc, rewriteConnectSrc } from './csp-policy.js';

const sources = import.meta.glob<string>('./**/*-api.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

function connectSrc(html: string): string[] {
  const policy = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
  return (
    policy
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('connect-src '))
      ?.split(/\s+/)
      .slice(1) ?? []
  );
}

describe('CSP de producción (AWS-16)', () => {
  it('knows exactly the API defaults the client modules use', () => {
    const fromClients = Object.values(sources).flatMap((source) =>
      [...source.matchAll(/(VITE_[A-Z_]+_API_URL) \?\? '(http[^']+)'/g)].map(
        (match) => `${match[1]}=${match[2]}`,
      ),
    );
    const expected = Object.entries(API_URL_DEFAULTS).map(([name, url]) => `${name}=${url}`);
    expect([...new Set(fromClients)].sort()).toEqual(expected.sort());
  });

  it('allows only self and the configured API origins, without localhost or ws: (AWS)', () => {
    const domain = 'https://d111111abcdef8.cloudfront.net';
    const env = Object.fromEntries(Object.keys(API_URL_DEFAULTS).map((name) => [name, domain]));
    const html = rewriteConnectSrc(indexHtml, productionConnectSrc(env));
    expect(connectSrc(html)).toEqual(["'self'", domain]);
    expect(html).not.toMatch(/localhost|ws:\/\//);
    // El resto de la política no cambia.
    expect(html).toContain("script-src 'self'");
    expect(html).toContain("object-src 'none'");
  });

  it('treats empty URLs as same-origin and keeps local defaults for a plain build', () => {
    const empty = Object.fromEntries(Object.keys(API_URL_DEFAULTS).map((name) => [name, '']));
    expect(productionConnectSrc(empty)).toEqual(["'self'"]);
    expect(productionConnectSrc({})).toEqual([
      "'self'",
      'http://127.0.0.1:3001',
      'http://127.0.0.1:3002',
      'http://127.0.0.1:3003',
      'http://127.0.0.1:3004',
    ]);
  });

  it('fails the build on invalid URLs or a missing directive', () => {
    expect(() => productionConnectSrc({ VITE_AUDIT_API_URL: 'javascript:alert(1)' })).toThrow(
      'VITE_AUDIT_API_URL',
    );
    expect(() => rewriteConnectSrc('<html></html>', ["'self'"])).toThrow('connect-src');
  });
});
