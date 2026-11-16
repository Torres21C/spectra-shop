import { afterEach, describe, expect, it, vi } from 'vitest';
import { addCartItem, CartApiError, getCart } from './cart-api.js';

const cart = {
  id: '30000000-0000-4000-8000-000000000001',
  status: 'ACTIVO',
  items: [
    {
      id: '40000000-0000-4000-8000-000000000001',
      productId: '20000000-0000-4000-8000-000000000015',
      name: 'Organizador Lumen',
      quantity: 2,
      unitPrice: '325.00',
      subtotal: '650.00',
      available: true,
    },
  ],
  itemCount: 2,
  distinctItems: 1,
  total: '650.00',
  currency: 'GTQ',
  checkoutAllowed: true,
  updatedAt: '2026-11-16T17:00:00.000Z',
};

describe('cart client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the server-owned cart mutation with credentials and CSRF', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ csrfToken: 'synthetic-csrf' }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(cart), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(addCartItem('20000000-0000-4000-8000-000000000015', 2)).resolves.toMatchObject({
      total: '650.00',
      itemCount: 2,
    });
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe('http://127.0.0.1:3003/cart/items');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      redirect: 'error',
      body: JSON.stringify({
        productId: '20000000-0000-4000-8000-000000000015',
        quantity: 2,
      }),
    });
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('synthetic-csrf');
  });

  it('fails closed when Commerce returns an invalid cart contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ ...cart, total: 650 }), { status: 200 })),
    );
    await expect(getCart()).rejects.toBeInstanceOf(CartApiError);
  });
});
