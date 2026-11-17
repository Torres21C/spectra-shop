import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuditEventsTable, validateProductForm } from './AdminPages.js';

const IMG = '<img src=x onerror=alert(1)>';

describe('admin views (M06/M07 mínimo)', () => {
  it('CA-M06-07: renders audit metadata as escaped literal text', () => {
    const markup = renderToStaticMarkup(
      <AuditEventsTable
        events={[
          {
            id: 'e1',
            sourceService: 'catalog',
            eventType: 'PRODUCT_CREATED',
            result: 'EXITO',
            actorId: '0f9c7d2e-3a1b-4c5d-8e6f-7a8b9c0d1e2f',
            actorRole: 'ADMIN',
            resourceType: 'product',
            resourceId: '3b5a1c9e-2d4f-4a6b-8c0d-1e2f3a4b5c6d',
            sourceIp: null,
            requestId: null,
            metadata: { sku: 'SP-XSS-001', name: IMG, stock: 3 },
            occurredAt: '2026-11-17T19:00:00.000Z',
          },
        ]}
      />,
    );
    expect(markup).toContain('PRODUCT_CREATED');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).not.toContain(IMG);
  });

  it('validates the new-product form like the server', () => {
    const valid = {
      sku: 'SP-DEMO-001',
      name: 'Teclado Demo',
      description: '',
      categoryId: 'c',
      price: '199.90',
      stock: '10',
    };
    expect(validateProductForm(valid)).toEqual({});
    expect(
      Object.keys(
        validateProductForm({
          ...valid,
          sku: 'sp-1',
          name: 'ab',
          categoryId: '',
          price: '0',
          stock: '-1',
        }),
      ).sort(),
    ).toEqual(['categoryId', 'name', 'price', 'sku', 'stock']);
    expect(validateProductForm({ ...valid, price: '1.999' })).toHaveProperty('price');
    expect(validateProductForm({ ...valid, stock: '10000' })).toHaveProperty('stock');
  });
});
