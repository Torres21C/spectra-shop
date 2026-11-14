export type Availability = 'OUT_OF_STOCK' | 'LOW_STOCK' | 'AVAILABLE';

export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es-GT')
    .trim();
}

export function availabilityForStock(stock: number): Availability {
  if (stock === 0) return 'OUT_OF_STOCK';
  if (stock <= 5) return 'LOW_STOCK';
  return 'AVAILABLE';
}
