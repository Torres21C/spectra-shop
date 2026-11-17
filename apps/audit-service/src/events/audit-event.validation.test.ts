import { describe, expect, it } from 'vitest';
import { parseIngestBatch } from './audit-event.validation.js';

const event = {
  id: '7c2f6a47-1b1e-4f4c-9a51-5b2f2e7d8a01',
  sourceService: 'catalog',
  eventType: 'PRODUCT_CREATED',
  result: 'EXITO',
  actorId: '0f9c7d2e-3a1b-4c5d-8e6f-7a8b9c0d1e2f',
  actorRole: 'ADMIN',
  resourceType: 'product',
  resourceId: '3b5a1c9e-2d4f-4a6b-8c0d-1e2f3a4b5c6d',
  sourceIp: '172.18.0.5',
  requestId: '9d8c7b6a-5f4e-4d3c-9b2a-1f0e9d8c7b6a',
  metadata: { sku: 'SP-DEMO-001', name: 'Teclado', price: '199.90', stock: 5, isActive: true },
  occurredAt: '2026-11-17T19:00:00.000Z',
};

describe('audit ingest validation (M07 mínimo)', () => {
  it('accepts a whitelisted PRODUCT_CREATED event from Catalog', () => {
    const [parsed] = parseIngestBatch({ events: [event] });
    expect(parsed).toMatchObject({
      id: event.id,
      eventType: 'PRODUCT_CREATED',
      actorRole: 'ADMIN',
    });
    expect(parsed!.occurredAt).toBeInstanceOf(Date);
  });

  it.each([
    ['an undeclared root field', { events: [event], extra: true }],
    ['an empty batch', { events: [] }],
    ['more than 100 events', { events: Array.from({ length: 101 }, () => event) }],
    ['an undeclared event field', { events: [{ ...event, password: 'x' }] }],
    [
      'an event type outside the closed list',
      { events: [{ ...event, eventType: 'ORDER_DELETED' }] },
    ],
    ['an unknown source service', { events: [{ ...event, sourceService: 'web' }] }],
    ['a non-UUID id', { events: [{ ...event, id: '1' }] }],
    ['an invalid result', { events: [{ ...event, result: 'OK' }] }],
    ['an unknown role', { events: [{ ...event, actorRole: 'ROOT' }] }],
    ['an invalid date', { events: [{ ...event, occurredAt: 'yesterday' }] }],
    ['a secret-like metadata key', { events: [{ ...event, metadata: { accessToken: 'abc' } }] }],
    ['a cookie metadata key', { events: [{ ...event, metadata: { cookie: 'spectra' } }] }],
    ['nested metadata', { events: [{ ...event, metadata: { nested: { a: 1 } } }] }],
    [
      'an oversized metadata value',
      { events: [{ ...event, metadata: { name: 'x'.repeat(201) } }] },
    ],
  ])('rejects %s', (_label, body) => {
    expect(() => parseIngestBatch(body)).toThrow();
  });
});
