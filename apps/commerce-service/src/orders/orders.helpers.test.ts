import { describe, expect, it } from 'vitest';
import {
  InconsistentOrderTimelineError,
  ORDER_HISTORY_PAGE_SIZE,
  type OrderTimelineColumns,
  orderTimeline,
  statusChangedAt,
  totalPages,
} from './orders.helpers.js';

const PAID = new Date('2026-11-17T10:00:00.000Z');
const PREPARING = new Date('2026-11-17T12:00:00.000Z');
const SHIPPED = new Date('2026-11-18T09:30:00.000Z');
const DELIVERED = new Date('2026-11-19T15:45:00.000Z');
const CANCELLED = new Date('2026-11-17T13:00:00.000Z');

function columns(overrides: Partial<OrderTimelineColumns>): OrderTimelineColumns {
  return {
    status: 'PAGADO',
    paidAt: PAID,
    preparingAt: null,
    shippedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

describe('M05 order timeline (D-M05-01, RF-028)', () => {
  it('an M04 order (PAGADO only) has a single milestone dated paid_at', () => {
    const order = columns({});
    expect(orderTimeline(order)).toEqual([{ status: 'PAGADO', at: PAID.toISOString() }]);
    expect(statusChangedAt(order)).toBe(PAID.toISOString());
  });

  it('CA-M05-04: the current status date is the last recorded change along RN-24', () => {
    const delivered = columns({
      status: 'ENTREGADO',
      preparingAt: PREPARING,
      shippedAt: SHIPPED,
      deliveredAt: DELIVERED,
    });
    expect(orderTimeline(delivered).map((entry) => entry.status)).toEqual([
      'PAGADO',
      'EN_PREPARACION',
      'ENVIADO',
      'ENTREGADO',
    ]);
    expect(statusChangedAt(delivered)).toBe(DELIVERED.toISOString());
    const shipped = columns({ status: 'ENVIADO', preparingAt: PREPARING, shippedAt: SHIPPED });
    expect(statusChangedAt(shipped)).toBe(SHIPPED.toISOString());
  });

  it('a cancellation is the final milestone and dates the CANCELADO status', () => {
    const cancelled = columns({
      status: 'CANCELADO',
      preparingAt: PREPARING,
      cancelledAt: CANCELLED,
    });
    expect(orderTimeline(cancelled)).toEqual([
      { status: 'PAGADO', at: PAID.toISOString() },
      { status: 'EN_PREPARACION', at: PREPARING.toISOString() },
      { status: 'CANCELADO', at: CANCELLED.toISOString() },
    ]);
    expect(statusChangedAt(cancelled)).toBe(CANCELLED.toISOString());
  });

  it('fails closed when the status has no date instead of showing a wrong one', () => {
    expect(() => statusChangedAt(columns({ status: 'ENVIADO' }))).toThrow(
      InconsistentOrderTimelineError,
    );
  });
});

describe('M05 server-side pagination (D-M05-04)', () => {
  it('uses a fixed page size of 10', () => {
    expect(ORDER_HISTORY_PAGE_SIZE).toBe(10);
    expect(totalPages(0)).toBe(0);
    expect(totalPages(10)).toBe(1);
    expect(totalPages(11)).toBe(2);
    expect(totalPages(23)).toBe(3);
  });
});
