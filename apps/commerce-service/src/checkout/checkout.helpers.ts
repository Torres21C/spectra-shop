import { createHash } from 'node:crypto';
import type {
  CatalogCartSnapshot,
  CheckoutConflictLine,
  CheckoutSummaryLine,
  GuatemalaDepartment,
  ShippingDetails,
  StockReservationLine,
} from '@spectra/contracts';
import { Decimal } from 'decimal.js';
import { evaluateLine, money, ZERO } from '../common/pricing.js';

export const GUATEMALA_DEPARTMENTS: readonly GuatemalaDepartment[] = [
  'Alta Verapaz',
  'Baja Verapaz',
  'Chimaltenango',
  'Chiquimula',
  'El Progreso',
  'Escuintla',
  'Guatemala',
  'Huehuetenango',
  'Izabal',
  'Jalapa',
  'Jutiapa',
  'Petén',
  'Quetzaltenango',
  'Quiché',
  'Retalhuleu',
  'Sacatepéquez',
  'San Marcos',
  'Santa Rosa',
  'Sololá',
  'Suchitepéquez',
  'Totonicapán',
  'Zacapa',
];

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AttemptLine {
  readonly productId: string;
  readonly quantity: number;
}

export interface PricedSummary {
  readonly lines: CheckoutSummaryLine[];
  readonly total: string;
  readonly fingerprint: string;
  readonly allAvailable: boolean;
  readonly conflicts: CheckoutConflictLine[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Huella del resumen calculado en servidor (DISC-M04-05). Permite detectar el flujo A4
 * (precio o cantidades cambiadas) sin aceptar importes del cliente (CA-M04-04, PT07).
 */
export function summaryFingerprint(
  lines: readonly { productId: string; quantity: number; unitPrice: string }[],
  total: string,
): string {
  const canonical = [...lines]
    .sort((left, right) => left.productId.localeCompare(right.productId))
    .map((line) => `${line.productId}:${line.quantity}:${line.unitPrice}`)
    .join('|');
  return sha256(`spectra-checkout-v1|${canonical}|${total}`);
}

export function priceSummary(
  items: readonly AttemptLine[],
  snapshots: readonly CatalogCartSnapshot[],
): PricedSummary {
  const byId = new Map(snapshots.map((product) => [product.id, product]));
  let total = ZERO;
  const conflicts: CheckoutConflictLine[] = [];
  const lines = items.map((item): CheckoutSummaryLine => {
    const product = byId.get(item.productId);
    const { unitPrice, subtotal, reason } = evaluateLine(product, item.quantity);
    if (reason) {
      conflicts.push({
        productId: item.productId,
        reason: reason === 'INACTIVE' ? 'INACTIVE' : 'INSUFFICIENT_STOCK',
        available: reason === 'INACTIVE' ? 0 : Math.min(product?.stock ?? 0, 10),
      });
    } else {
      total = total.add(subtotal);
    }
    return {
      productId: item.productId,
      name: product?.name ?? 'Producto no disponible',
      quantity: item.quantity,
      unitPrice: unitPrice.toFixed(2),
      subtotal: subtotal.toFixed(2),
      available: reason === undefined,
      ...(reason ? { unavailableReason: reason } : {}),
    };
  });
  const totalText = money(total).toFixed(2);
  return {
    lines,
    total: totalText,
    fingerprint: summaryFingerprint(lines, totalText),
    allAvailable: lines.length > 0 && conflicts.length === 0,
    conflicts,
  };
}

/** CA-M04-04: total = Σ(precio persistido × cantidad) con los precios congelados por Catalog. */
export function orderTotals(lines: readonly StockReservationLine[]): {
  total: Decimal;
  items: { line: StockReservationLine; lineTotal: Decimal }[];
} {
  let total = ZERO;
  const items = lines.map((line) => {
    const lineTotal = money(new Decimal(line.unitPrice).mul(line.quantity));
    total = total.add(lineTotal);
    return { line, lineTotal };
  });
  return { total: money(total), items };
}

/** Hash canónico del cuerpo para detectar la reutilización de una clave con otro contenido. */
export function requestHash(body: {
  readonly recipientName: string;
  readonly phone: string;
  readonly department: string;
  readonly municipality: string;
  readonly address: string;
  readonly references?: string | undefined;
  readonly simulatedPaymentResult: string;
  readonly cartFingerprint: string;
}): string {
  return sha256(
    JSON.stringify([
      body.recipientName,
      body.phone,
      body.department,
      body.municipality,
      body.address,
      body.references ?? null,
      body.simulatedPaymentResult,
      body.cartFingerprint,
    ]),
  );
}

export function normalizeText(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ');
}

export function normalizePhone(value: string): string {
  const digits = value.replace('-', '');
  return `${digits.slice(0, 4)}-${digits.slice(4)}`;
}

export function shippingFrom(dto: ShippingDetails): ShippingDetails {
  return {
    recipientName: dto.recipientName,
    phone: dto.phone,
    department: dto.department,
    municipality: dto.municipality,
    address: dto.address,
    ...(dto.references ? { references: dto.references } : {}),
  };
}

export function paymentReference(randomHex: string): string {
  return `SIM-${randomHex.toUpperCase()}`;
}
