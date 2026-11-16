import type { CatalogCartSnapshot } from '@spectra/contracts';
import { Decimal } from 'decimal.js';

export type UnavailableReason = 'INACTIVE' | 'OUT_OF_STOCK' | 'INSUFFICIENT_STOCK';

export interface EvaluatedLine {
  readonly unitPrice: Decimal;
  readonly subtotal: Decimal;
  readonly reason: UnavailableReason | undefined;
}

export const ZERO = new Decimal(0);

/** RN-12: subtotal = precio persistido × cantidad, redondeo HALF_UP a 2 decimales. */
export function money(value: Decimal.Value): Decimal {
  return new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Reglas compartidas por el carrito (M03) y el checkout (M04). El precio sale siempre de Catalog. */
export function evaluateLine(
  product: CatalogCartSnapshot | undefined,
  quantity: number,
): EvaluatedLine {
  const reason: UnavailableReason | undefined =
    !product || !product.isActive
      ? 'INACTIVE'
      : product.stock === 0
        ? 'OUT_OF_STOCK'
        : product.stock < quantity
          ? 'INSUFFICIENT_STOCK'
          : undefined;
  const unitPrice = new Decimal(product?.price ?? '0.00');
  const subtotal = reason ? ZERO : money(unitPrice.mul(quantity));
  return { unitPrice, subtotal, reason };
}
