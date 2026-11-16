import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckoutApiError, getCheckoutSummary, placeOrder } from './checkout-api.js';

const order = {
  id: '50000000-0000-4000-8000-000000000001',
  orderNumber: 'SP-10001',
  status: 'PAGADO',
  total: '300.00',
  currency: 'GTQ',
  itemCount: 2,
  paymentReference: 'SIM-0A1B2C3D4E5F6071',
  createdAt: '2026-11-17T10:00:00.000Z',
  items: [
    {
      productId: '20000000-0000-4000-8000-000000000005',
      name: 'Mouse sintético',
      quantity: 2,
      unitPrice: '150.00',
      lineTotal: '300.00',
    },
  ],
  shipping: {
    recipientName: 'Ana Pérez',
    phone: '5555-0101',
    department: 'Guatemala',
    municipality: 'Mixco',
    address: 'Calle ficticia 1-23',
  },
};

const request = {
  recipientName: 'Ana Pérez',
  phone: '5555-0101',
  department: 'Guatemala',
  municipality: 'Mixco',
  address: 'Calle ficticia 1-23',
  simulatedPaymentResult: 'APROBADO' as const,
  cartFingerprint: 'a'.repeat(64),
};

describe('checkout client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends Idempotency-Key, CSRF and credentials without any amount or card field', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'synthetic-csrf' })))
      .mockResolvedValueOnce(new Response(JSON.stringify(order), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const attemptKey = crypto.randomUUID();
    await expect(placeOrder(request, attemptKey)).resolves.toMatchObject({
      created: true,
      order: { orderNumber: 'SP-10001', total: '300.00' },
    });
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe('http://127.0.0.1:3003/orders');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', redirect: 'error' });
    const headers = new Headers(init?.headers);
    expect(headers.get('Idempotency-Key')).toBe(attemptKey);
    expect(headers.get('X-CSRF-Token')).toBe('synthetic-csrf');
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(Object.keys(body)).not.toEqual(
      expect.arrayContaining(['total', 'price', 'cardNumber', 'cvv']),
    );
    expect(body).not.toHaveProperty('total');
  });

  it('exposes the error code and conflict lines for UI handling', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'synthetic-csrf' })))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              statusCode: 409,
              code: 'CHECKOUT_STOCK_CONFLICT',
              message: 'Stock insuficiente para una o más líneas',
              requestId: '60000000-0000-4000-8000-000000000001',
              timestamp: '2026-11-17T10:00:00.000Z',
              details: {
                conflicts: [
                  {
                    productId: '20000000-0000-4000-8000-000000000005',
                    reason: 'INSUFFICIENT_STOCK',
                    available: 1,
                  },
                ],
              },
            }),
            { status: 409 },
          ),
        ),
    );
    const failure = await placeOrder(request, crypto.randomUUID()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CheckoutApiError);
    expect(failure).toMatchObject({
      status: 409,
      code: 'CHECKOUT_STOCK_CONFLICT',
      conflicts: [{ reason: 'INSUFFICIENT_STOCK', available: 1 }],
    });
  });

  it('treats a missing response as pending so the same key can be retried', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: 'synthetic-csrf' })))
        .mockRejectedValueOnce(new TypeError('network')),
    );
    await expect(placeOrder(request, crypto.randomUUID())).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
  });

  it('fails closed when the summary contract is invalid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            cartId: '30000000-0000-4000-8000-000000000001',
            items: [],
            itemCount: 0,
            total: 300,
            currency: 'GTQ',
            fingerprint: 'a'.repeat(64),
            checkoutAllowed: true,
            checkoutInProgress: false,
          }),
        ),
      ),
    );
    await expect(getCheckoutSummary()).rejects.toBeInstanceOf(CheckoutApiError);
  });
});
