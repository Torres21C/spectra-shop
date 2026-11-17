import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApiError, createProduct, getAuditEvents } from './admin-api.js';

const created = {
  id: '20000000-0000-4000-8000-0000000000aa',
  sku: 'SP-DEMO-001',
  name: 'Teclado Demo',
  price: '199.90',
  stock: 10,
  isActive: true,
  category: { id: 'c', slug: 'audio', name: 'Audio' },
};

describe('admin client (M06/M07 mínimo)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('creates a product with credentials, CSRF and only the whitelisted fields', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'csrf-1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(created), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createProduct({
        sku: 'SP-DEMO-001',
        name: 'Teclado Demo',
        description: '',
        categoryId: '10000000-0000-4000-8000-000000000001',
        price: '199.90',
        stock: 10,
      }),
    ).resolves.toMatchObject({ id: created.id, sku: 'SP-DEMO-001' });

    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe('http://127.0.0.1:3002/admin/products');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', redirect: 'error' });
    expect(new Headers(init!.headers).get('X-CSRF-Token')).toBe('csrf-1');
    expect(JSON.parse(init!.body as string)).toEqual({
      sku: 'SP-DEMO-001',
      name: 'Teclado Demo',
      categoryId: '10000000-0000-4000-8000-000000000001',
      price: '199.90',
      stock: 10,
    });
  });

  it('maps a duplicate SKU (409) to a clear error', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'c' }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ statusCode: 409, code: 'SKU_DUPLICATED' }), {
            status: 409,
          }),
        ),
    );
    const error = await createProduct({
      sku: 'SP-DEMO-001',
      name: 'Teclado Demo',
      description: '',
      categoryId: 'c',
      price: '1.00',
      stock: 1,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AdminApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'SKU_DUPLICATED',
      message: 'El SKU ya existe.',
    });
  });

  it('reads the latest audit events with credentials and rejects malformed payloads', async () => {
    const event = {
      id: 'e1',
      sourceService: 'catalog',
      eventType: 'PRODUCT_CREATED',
      result: 'EXITO',
      actorId: 'a1',
      actorRole: 'ADMIN',
      resourceType: 'product',
      resourceId: 'p1',
      sourceIp: '172.18.0.5',
      requestId: 'r1',
      metadata: { sku: 'SP-DEMO-001' },
      occurredAt: '2026-11-17T19:00:00.000Z',
      receivedAt: '2026-11-17T19:00:01.000Z',
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [event] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ ...event, metadata: 'x' }] }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(getAuditEvents()).resolves.toMatchObject([{ eventType: 'PRODUCT_CREATED' }]);
    expect(fetchMock.mock.calls[0]![0]).toBe('http://127.0.0.1:3004/admin/audit-events?limit=50');
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: 'include' });
    await expect(getAuditEvents()).rejects.toBeInstanceOf(AdminApiError);
  });
});
