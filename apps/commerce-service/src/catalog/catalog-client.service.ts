import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { CatalogCartSnapshot, CatalogCartSnapshotResponse } from '@spectra/contracts';
import { commerceConfig } from '../config/commerce.config.js';

function decodeProduct(value: unknown): CatalogCartSnapshot {
  if (typeof value !== 'object' || value === null) throw new Error('product');
  const record = value as Record<string, unknown>;
  const id = record['id'];
  const name = record['name'];
  const price = record['price'];
  const stock = record['stock'];
  const isActive = record['isActive'];
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof price !== 'string' ||
    !/^\d{1,8}\.\d{2}$/.test(price) ||
    typeof stock !== 'number' ||
    !Number.isInteger(stock) ||
    stock < 0 ||
    typeof isActive !== 'boolean'
  ) {
    throw new Error('product');
  }
  return { id, name, price, stock, isActive };
}

@Injectable()
export class CatalogClientService {
  async snapshot(productIds: readonly string[], requestId: string): Promise<CatalogCartSnapshot[]> {
    if (productIds.length === 0) return [];
    const url = new URL('/internal/catalog/cart-snapshot', commerceConfig.catalogUrl);
    try {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(commerceConfig.timeoutMs),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Spectra-Internal-Token': commerceConfig.internalToken,
          'X-Request-Id': requestId,
        },
        body: JSON.stringify({ productIds }),
      });
      if (!response.ok) throw new Error(`catalog status ${response.status}`);
      const payload = (await response.json()) as Partial<CatalogCartSnapshotResponse>;
      if (!Array.isArray(payload.products)) throw new Error('catalog response');
      return payload.products.map(decodeProduct);
    } catch {
      throw new ServiceUnavailableException({
        code: 'CATALOG_UNAVAILABLE',
        message: 'Catálogo no disponible',
      });
    }
  }
}
