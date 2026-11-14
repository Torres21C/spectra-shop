import { describe, expect, it } from 'vitest';
import { availabilityForStock, normalizeSearchText } from './catalog.helpers.js';

describe('catalog helpers', () => {
  it('maps stock to public availability ranges without exposing exact quantities', () => {
    expect(availabilityForStock(0)).toBe('OUT_OF_STOCK');
    expect(availabilityForStock(1)).toBe('LOW_STOCK');
    expect(availabilityForStock(5)).toBe('LOW_STOCK');
    expect(availabilityForStock(6)).toBe('AVAILABLE');
  });

  it('normalizes case and accents for literal search', () => {
    expect(normalizeSearchText('  TECLÁDO Mecánico  ')).toBe('teclado mecanico');
    expect(normalizeSearchText("' OR '1'='1")).toBe("' or '1'='1");
  });
});
