import { isIP } from 'node:net';

/**
 * AWS-11: detrás de CloudFront y del ALB, `request.ip` sería la IP del balanceador y los límites por IP
 * (throttler) se volverían globales. TRUST_PROXY indica en qué proxies confiar para leer X-Forwarded-For:
 *   - sin definir o `false`: en ninguno (desarrollo local; comportamiento anterior);
 *   - un entero de 1 a 10: número de saltos de proxy de confianza;
 *   - IP o CIDR separadas por comas (p. ej. la CIDR de la VPC `10.20.0.0/16`).
 * `true` (confiar en cualquiera) se rechaza: permitiría falsificar la IP con la cabecera.
 */
export function trustProxySetting(
  value: string | undefined = process.env.TRUST_PROXY,
): number | string | false {
  const raw = value?.trim();
  if (!raw || raw === 'false') return false;
  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    if (hops >= 1 && hops <= 10) return hops;
  } else {
    const entries = raw.split(',').map((entry) => entry.trim());
    if (entries.every(isAddressOrCidr)) return entries.join(',');
  }
  throw new Error('TRUST_PROXY debe ser false, un número de saltos (1-10) o una lista de IP/CIDR');
}

function isAddressOrCidr(entry: string): boolean {
  const [address, prefix, ...rest] = entry.split('/');
  if (rest.length > 0 || !address) return false;
  const family = isIP(address);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}
