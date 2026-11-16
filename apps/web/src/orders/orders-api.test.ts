import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckoutApiError } from '../checkout/checkout-api.js';
import { getOrderDetail, getOrderHistory, SESSION_EXPIRED } from './orders-api.js';

const ORDER_ID = '50000000-0000-4000-8000-000000000001';

const summary = {
  id: ORDER_ID,
  orderNumber: 'SP-10001',
  status: 'ENVIADO',
  statusChangedAt: '2026-11-18T09:30:00.000Z',
  createdAt: '2026-11-17T10:00:00.000Z',
  itemCount: 2,
  total: '300.00',
  currency: 'GTQ',
};

const detail = {
  id: ORDER_ID,
  orderNumber: 'SP-10001',
  status: 'ENVIADO',
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
  statusChangedAt: '2026-11-18T09:30:00.000Z',
  timeline: [
    { status: 'PAGADO', at: '2026-11-17T10:00:00.000Z' },
    { status: 'EN_PREPARACION', at: '2026-11-17T12:00:00.000Z' },
    { status: 'ENVIADO', at: '2026-11-18T09:30:00.000Z' },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('M05 orders client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('D-M05-04: sends only the page number with credentials; size and owner stay on the server', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        json({
          items: [summary],
          meta: { page: 2, pageSize: 10, totalItems: 11, totalPages: 2 },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const page = await getOrderHistory(2);
    expect(page.items[0]).toEqual(summary);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:3003/orders?page=2');
    expect(init).toMatchObject({ credentials: 'include', redirect: 'error' });

    await getOrderHistory(Number.NaN);
    await getOrderHistory(-3);
    expect(fetchMock.mock.calls.slice(1).map(([target]) => target)).toEqual([
      'http://127.0.0.1:3003/orders?page=1',
      'http://127.0.0.1:3003/orders?page=1',
    ]);
  });

  it('RF-028: decodes the detail with its current status date and timeline', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json(detail));
    vi.stubGlobal('fetch', fetchMock);
    const order = await getOrderDetail(ORDER_ID);
    expect(order.statusChangedAt).toBe('2026-11-18T09:30:00.000Z');
    expect(order.timeline.map((entry) => entry.status)).toEqual([
      'PAGADO',
      'EN_PREPARACION',
      'ENVIADO',
    ]);
    expect(fetchMock.mock.calls[0]![0]).toBe(`http://127.0.0.1:3003/orders/${ORDER_ID}`);
  });

  it('D-M05-03: an order number or a crafted path never reaches the API', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    for (const candidate of ['SP-10001', '../cart', `${ORDER_ID}/cancel`, '1']) {
      await expect(getOrderDetail(candidate)).rejects.toMatchObject({
        status: 404,
        code: 'ORDER_NOT_FOUND',
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('RF-029: a foreign or unknown order surfaces the uniform 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        json(
          {
            statusCode: 404,
            code: 'ORDER_NOT_FOUND',
            message: 'Pedido no encontrado',
            requestId: '60000000-0000-4000-8000-000000000001',
            timestamp: '2026-11-17T10:00:00.000Z',
          },
          404,
        ),
      ),
    );
    await expect(getOrderDetail(ORDER_ID)).rejects.toMatchObject({
      status: 404,
      code: 'ORDER_NOT_FOUND',
      message: 'Pedido no encontrado',
    });
  });

  it('A3: an expired session that cannot be refreshed is reported as SESSION_EXPIRED', async () => {
    const unauthorized = {
      statusCode: 401,
      code: 'AUTH_REQUIRED',
      message: 'Autenticación requerida',
      requestId: '60000000-0000-4000-8000-000000000002',
      timestamp: '2026-11-17T10:00:00.000Z',
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(unauthorized, 401))
      .mockResolvedValueOnce(json({ csrfToken: 'synthetic-csrf' }))
      .mockResolvedValueOnce(json(unauthorized, 401));
    vi.stubGlobal('fetch', fetchMock);
    const failure = await getOrderHistory(1).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CheckoutApiError);
    expect(failure).toMatchObject({ status: 401, code: SESSION_EXPIRED });
    expect(fetchMock.mock.calls[2]![0]).toBe('http://127.0.0.1:3001/auth/refresh');
  });

  it('fails closed on contracts that do not match (status, amounts, timeline, page size)', async () => {
    const invalidPayloads = [
      {
        items: [{ ...summary, status: 'PERDIDO' }],
        meta: { page: 1, pageSize: 10, totalItems: 1, totalPages: 1 },
      },
      {
        items: [{ ...summary, total: 300 }],
        meta: { page: 1, pageSize: 10, totalItems: 1, totalPages: 1 },
      },
      { items: [summary, summary], meta: { page: 1, pageSize: 1, totalItems: 2, totalPages: 2 } },
      {
        items: [{ ...summary, id: 'SP-10001' }],
        meta: { page: 1, pageSize: 10, totalItems: 1, totalPages: 1 },
      },
    ];
    for (const payload of invalidPayloads) {
      vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(payload)));
      await expect(getOrderHistory(1)).rejects.toBeInstanceOf(CheckoutApiError);
    }
    for (const payload of [
      { ...detail, timeline: [] },
      { ...detail, timeline: [{ status: 'PAGADO', at: 'ayer' }] },
      { ...detail, statusChangedAt: undefined },
    ]) {
      vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(json(payload)));
      await expect(getOrderDetail(ORDER_ID)).rejects.toBeInstanceOf(CheckoutApiError);
    }
  });
});
