import { renderToStaticMarkup } from 'react-dom/server';
import type { OrderDetail, OrderHistoryPage } from '@spectra/contracts';
import { describe, expect, it } from 'vitest';
import { OrderDetailView, OrderHistoryView } from './OrderViews.js';

const ORDER_ID = '50000000-0000-4000-8000-000000000001';
const SCRIPT = '<script>alert(1)</script>';
const IMG = '<img src=x onerror=alert(1)>';

const detail: OrderDetail = {
  id: ORDER_ID,
  orderNumber: 'SP-10001',
  status: 'CANCELADO',
  total: '10.00',
  currency: 'GTQ',
  itemCount: 1,
  paymentReference: 'SIM-0A1B2C3D4E5F6071',
  createdAt: '2026-11-17T10:00:00.000Z',
  items: [
    {
      productId: '20000000-0000-4000-8000-000000000005',
      name: `${IMG}${SCRIPT}`,
      quantity: 1,
      unitPrice: '10.00',
      lineTotal: '10.00',
    },
  ],
  shipping: {
    recipientName: 'Ana Pérez',
    phone: '5555-0101',
    department: 'Guatemala',
    municipality: 'Mixco',
    address: `Calle ${SCRIPT}`,
    references: SCRIPT,
  },
  statusChangedAt: '2026-11-17T13:00:00.000Z',
  timeline: [
    { status: 'PAGADO', at: '2026-11-17T10:00:00.000Z' },
    { status: 'EN_PREPARACION', at: '2026-11-17T12:00:00.000Z' },
    { status: 'CANCELADO', at: '2026-11-17T13:00:00.000Z' },
  ],
};

function page(overrides: Partial<OrderHistoryPage['meta']>, count = 1): OrderHistoryPage {
  return {
    items: Array.from({ length: count }, (_, index) => ({
      id: `50000000-0000-4000-8000-00000000000${index}`,
      orderNumber: `SP-1000${index}`,
      status: 'PAGADO' as const,
      statusChangedAt: '2026-11-17T10:00:00.000Z',
      createdAt: '2026-11-17T10:00:00.000Z',
      itemCount: 3,
      total: '450.00',
      currency: 'GTQ' as const,
    })),
    meta: { page: 1, pageSize: 10, totalItems: count, totalPages: 1, ...overrides },
  };
}

describe('P07 order views', () => {
  it('RS04/PT02: hostile product names and delivery data render escaped as text', () => {
    const html = renderToStaticMarkup(<OrderDetailView order={detail} />);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('RF-027/RF-028: shows frozen prices, delivery, total and the dated timeline in order', () => {
    const html = renderToStaticMarkup(<OrderDetailView order={detail} />);
    expect(html).toContain('SP-10001');
    expect(html).toContain('(precio de la compra)');
    expect(html).toContain('Mixco');
    expect(html).toContain('SIM-0A1B2C3D4E5F6071');
    const labels = [...html.matchAll(/<li[^>]*><span class="order-badge[^"]*">([^<]+)</g)].map(
      (match) => match[1],
    );
    expect(labels).toEqual(['Pagado', 'En preparación', 'Cancelado']);
    expect(html).toContain('dateTime="2026-11-17T13:00:00.000Z"');
    expect(html).toMatch(
      /<li aria-current="step"><span class="order-badge order-badge-cancelado">/,
    );
    // RN-22: la vista no ofrece acciones de modificación o cancelación.
    expect(html).not.toMatch(/<button|<form/);
  });

  it('RF-026: links each order by UUID and shows the SP number only as text, without delivery data', () => {
    const html = renderToStaticMarkup(<OrderHistoryView history={page({}, 2)} />);
    expect(html).toContain('href="#/pedidos/50000000-0000-4000-8000-000000000000"');
    expect(html).not.toContain('href="#/pedidos/SP-');
    expect(html).toContain('SP-10001');
    expect(html).toContain('3 artículos');
    expect(html).not.toContain('Mixco');
  });

  it('A1: an empty history shows the empty state with a link to the catalog', () => {
    const html = renderToStaticMarkup(
      <OrderHistoryView
        history={{ items: [], meta: { page: 1, pageSize: 10, totalItems: 0, totalPages: 0 } }}
      />,
    );
    expect(html).toContain('Aún no tienes pedidos');
    expect(html).toContain('href="#/"');
  });

  it('server-side pagination renders previous/next links only when they exist', () => {
    const middle = renderToStaticMarkup(
      <OrderHistoryView history={page({ page: 2, totalItems: 25, totalPages: 3 })} />,
    );
    expect(middle).toContain('href="#/pedidos?page=1"');
    expect(middle).toContain('href="#/pedidos?page=3"');
    expect(middle).toContain('Página 2 de 3');
    const last = renderToStaticMarkup(
      <OrderHistoryView history={page({ page: 3, totalItems: 25, totalPages: 3 })} />,
    );
    expect(last).not.toContain('page=4');
    expect(last).toContain('aria-disabled="true"');
  });
});
