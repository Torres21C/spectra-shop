import { defineConfig, type Plugin } from 'vite';
import { productionConnectSrc, rewriteConnectSrc } from './src/csp-policy.js';

/** AWS-16: en `vite build`, `connect-src` = 'self' + orígenes de VITE_*_API_URL (sin localhost ni ws:). */
function productionCsp(): Plugin {
  let env: Readonly<Record<string, string | undefined>> = {};
  return {
    name: 'spectra-production-csp',
    apply: 'build',
    configResolved(config) {
      env = config.env;
    },
    transformIndexHtml(html) {
      return rewriteConnectSrc(html, productionConnectSrc(env));
    },
  };
}

export default defineConfig({ plugins: [productionCsp()] });
