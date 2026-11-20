/**
 * AWS-16: `connect-src` de la CSP de producción. `index.html` conserva la política de desarrollo
 * (orígenes localhost y `ws:` para el HMR de Vite); en `vite build` se sustituye por `'self'` más los
 * orígenes de las API configuradas en VITE_*_API_URL. Con la Web y la API en el mismo dominio (CloudFront),
 * basta con `'self'`.
 */
export const API_URL_DEFAULTS = {
  VITE_IDENTITY_API_URL: 'http://127.0.0.1:3001',
  VITE_CATALOG_API_URL: 'http://127.0.0.1:3002',
  VITE_COMMERCE_API_URL: 'http://127.0.0.1:3003',
  VITE_AUDIT_API_URL: 'http://127.0.0.1:3004',
} as const;

export function productionConnectSrc(env: Readonly<Record<string, string | undefined>>): string[] {
  const origins = new Set<string>();
  for (const [name, fallback] of Object.entries(API_URL_DEFAULTS)) {
    const value = env[name] ?? fallback;
    // Cadena vacía: URL relativa, es decir, el mismo origen que la página ('self').
    if (value === '') continue;
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`${name} debe ser una URL http(s)`);
    }
    origins.add(url.origin);
  }
  return ["'self'", ...[...origins].sort()];
}

const CONNECT_SRC = /(http-equiv="Content-Security-Policy"\s+content="[^"]*?)connect-src [^;"]*/;

export function rewriteConnectSrc(html: string, sources: readonly string[]): string {
  if (!CONNECT_SRC.test(html)) {
    throw new Error('index.html no contiene la directiva connect-src en su CSP');
  }
  return html.replace(CONNECT_SRC, `$1connect-src ${sources.join(' ')}`);
}
