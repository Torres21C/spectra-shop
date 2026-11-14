import { renderToStaticMarkup } from 'react-dom/server';
import type { ProductSummary } from '@spectra/contracts';
import { describe, expect, it } from 'vitest';
import { ProductCard } from './ProductCard.js';

const product: ProductSummary = {
  id: '20000000-0000-4000-8000-000000000003',
  name: '<script>alert(1)</script>',
  description: 'Texto seguro',
  category: { id: '10000000-0000-4000-8000-000000000001', slug: 'audio', name: 'Audio' },
  price: '799.00',
  currency: 'GTQ',
  availability: 'OUT_OF_STOCK',
  imageKey: 'headphones',
};

describe('ProductCard', () => {
  it('CA-M01-07 renders script-shaped product text escaped by React', () => {
    const html = renderToStaticMarkup(<ProductCard product={product} />);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('shows public availability without exact stock', () => {
    const html = renderToStaticMarkup(<ProductCard product={product} />);
    expect(html).toContain('Agotado');
    expect(product).not.toHaveProperty('stock');
  });
});
