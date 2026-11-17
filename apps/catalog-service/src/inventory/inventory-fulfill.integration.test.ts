import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type {
  StockReservationFulfillment,
  StockReservationState,
  UnfulfilledReservationsReport,
} from '@spectra/contracts';
import supertest, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// DT-08 (M06.0): contrato de reconocimiento de entrega (FULFILLED) y reporte de Catalog.
const HUB = '20000000-0000-4000-8000-000000000006';
const PAD = '20000000-0000-4000-8000-000000000010';
const PRODUCTS = [HUB, PAD];
const BASE: Record<string, { price: string; stock: number }> = {
  [HUB]: { price: '275.00', stock: 5 },
  [PAD]: { price: '120.00', stock: 3 },
};
const ROOT = '/internal/catalog/stock-reservations';

function parse<T>(response: Response): T {
  return JSON.parse(response.text) as T;
}

describe.skipIf(!process.env.DATABASE_URL || !process.env.CATALOG_INVENTORY_TOKENS)(
  'DT-08 reservation fulfillment with PostgreSQL (internal listener)',
  () => {
    let app: INestApplication;
    let publicApp: INestApplication;
    let server: Server;
    let prisma: import('@prisma/client').PrismaClient;
    let monitor: InstanceType<
      typeof import('./inventory-delivery-monitor.service.js').InventoryDeliveryMonitorService
    >;
    let token: string;
    let original: { id: string; price: string; stock: number; isActive: boolean }[];

    const call = (method: 'get' | 'post', path: string) =>
      supertest(server)[method](path).set('X-Spectra-Internal-Token', token);

    const fulfill = (reservationId: string, body: Record<string, unknown>) =>
      call('post', `${ROOT}/${reservationId}/fulfill`).send(body);

    async function confirmed(productId = HUB, quantity = 1): Promise<string> {
      const id = randomUUID();
      const reserved = await call('post', ROOT).send({
        reservationId: id,
        lines: [{ productId, quantity, expectedUnitPrice: BASE[productId]!.price }],
      });
      expect(reserved.status).toBe(201);
      expect((await call('post', `${ROOT}/${id}/confirm`)).status).toBe(200);
      return id;
    }

    async function row(id: string) {
      return prisma.stockReservation.findUniqueOrThrow({ where: { id } });
    }

    async function stock(id: string): Promise<number> {
      return (await prisma.product.findUniqueOrThrow({ where: { id } })).stock;
    }

    async function ageConfirmation(id: string, seconds: number): Promise<void> {
      await prisma.$executeRaw`
        UPDATE "catalog"."stock_reservations"
           SET "confirmed_at" = now() - (${seconds}::int * interval '1 second')
         WHERE "id" = ${id}::uuid`;
    }

    beforeAll(async () => {
      process.env.RESERVATION_SWEEP_INTERVAL_MS = '0';
      process.env.RESERVATION_DELIVERY_MONITOR_INTERVAL_MS = '0';
      token = process.env.CATALOG_INVENTORY_TOKENS!.split(',')[0]!.trim();
      const [{ InternalAppModule }, { AppModule }, fixtureModule, monitorModule] =
        await Promise.all([
          import('../internal-app.module.js'),
          import('../app.module.js'),
          import('../test-support/fixture-client.js'),
          import('./inventory-delivery-monitor.service.js'),
        ]);
      const pipe = new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        stopAtFirstError: true,
      });
      app = (await Test.createTestingModule({ imports: [InternalAppModule] }).compile())
        .createNestApplication()
        .useGlobalPipes(pipe);
      await app.init();
      publicApp = (await Test.createTestingModule({ imports: [AppModule] }).compile())
        .createNestApplication()
        .useGlobalPipes(pipe);
      await publicApp.init();
      server = app.getHttpServer() as Server;
      prisma = fixtureModule.createFixtureClient();
      monitor = app.get(monitorModule.InventoryDeliveryMonitorService);
      original = (await prisma.product.findMany({ where: { id: { in: PRODUCTS } } })).map(
        (product) => ({
          id: product.id,
          price: product.price.toFixed(2),
          stock: product.stock,
          isActive: product.isActive,
        }),
      );
    });

    beforeEach(async () => {
      await prisma.stockReservationLine.deleteMany();
      await prisma.stockReservation.deleteMany();
      for (const [id, values] of Object.entries(BASE)) {
        await prisma.product.update({
          where: { id },
          data: { price: values.price, stock: values.stock, isActive: true },
        });
      }
    });

    afterAll(async () => {
      if (prisma) {
        await prisma.stockReservationLine.deleteMany();
        await prisma.stockReservation.deleteMany();
        for (const product of original ?? []) {
          await prisma.product.update({
            where: { id: product.id },
            data: { price: product.price, stock: product.stock, isActive: product.isActive },
          });
        }
      }
      await app?.close();
      await publicApp?.close();
      await prisma?.$disconnect();
    });

    it('DT08-1/2/3: CONFIRMED → FULFILLED links exactly one order; 10 repeats give one 201 and nine 200 without touching stock or dates', async () => {
      const id = await confirmed(HUB, 2);
      const orderId = randomUUID();
      expect(await stock(HUB)).toBe(3);
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => fulfill(id, { orderId })),
      );
      expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
      expect(responses.filter((response) => response.status === 200)).toHaveLength(9);
      const bodies = responses.map((response) => parse<StockReservationFulfillment>(response));
      const first = (await row(id)).fulfilledAt!.toISOString();
      for (const body of bodies) {
        expect(body).toEqual({
          reservationId: id,
          status: 'FULFILLED',
          orderId,
          confirmedAt: expect.any(String) as string,
          fulfilledAt: first,
        });
      }
      const stored = await row(id);
      expect(stored).toMatchObject({ status: 'FULFILLED', orderId, releasedAt: null });
      expect(stored.fulfilledAt!.getTime()).toBeGreaterThanOrEqual(stored.confirmedAt!.getTime());
      expect(await stock(HUB)).toBe(3);
      // Repetición tardía: mismo resultado, mismas fechas.
      const late = await fulfill(id, { orderId });
      expect(late.status).toBe(200);
      expect(parse<StockReservationFulfillment>(late).fulfilledAt).toBe(first);
    });

    it('DT08-4/5: the same order cannot fulfill another reservation and a reservation cannot change order', async () => {
      const first = await confirmed(HUB);
      const second = await confirmed(PAD);
      const orderId = randomUUID();
      expect((await fulfill(first, { orderId })).status).toBe(201);

      const sameOrder = await fulfill(second, { orderId });
      expect(sameOrder.status).toBe(409);
      expect(parse<{ code: string }>(sameOrder).code).toBe('ORDER_RESERVATION_MISMATCH');
      expect(await row(second)).toMatchObject({ status: 'CONFIRMED', orderId: null });

      const otherOrder = await fulfill(first, { orderId: randomUUID() });
      expect(otherOrder.status).toBe(409);
      expect(parse<{ code: string }>(otherOrder).code).toBe('RESERVATION_ORDER_MISMATCH');
      expect(await row(first)).toMatchObject({ status: 'FULFILLED', orderId });
      expect(await stock(HUB)).toBe(4);
      expect(await stock(PAD)).toBe(2);
    });

    it('DT08-6: PENDING, RELEASED and unknown reservations are rejected without changes', async () => {
      const pending = randomUUID();
      await call('post', ROOT).send({
        reservationId: pending,
        lines: [{ productId: PAD, quantity: 1, expectedUnitPrice: '120.00' }],
      });
      const notConfirmed = await fulfill(pending, { orderId: randomUUID() });
      expect(notConfirmed.status).toBe(409);
      expect(parse<{ code: string }>(notConfirmed).code).toBe('RESERVATION_NOT_CONFIRMED');
      expect(await row(pending)).toMatchObject({ status: 'PENDING', orderId: null });

      await call('post', `${ROOT}/${pending}/release`);
      const released = await fulfill(pending, { orderId: randomUUID() });
      expect(released.status).toBe(409);
      expect(parse<{ code: string }>(released).code).toBe('RESERVATION_RELEASED');
      expect(await stock(PAD)).toBe(3);

      const unknown = await fulfill(randomUUID(), { orderId: randomUUID() });
      expect(unknown.status).toBe(404);
      expect(parse<{ code: string }>(unknown).code).toBe('RESERVATION_NOT_FOUND');
    });

    it('DT08-14: a fulfilled reservation is never released and stays confirmed for repeated confirmations', async () => {
      const id = await confirmed(HUB, 2);
      await fulfill(id, { orderId: randomUUID() });
      const release = await call('post', `${ROOT}/${id}/release`);
      expect(release.status).toBe(409);
      expect(parse<{ code: string }>(release).code).toBe('RESERVATION_CONFIRMED');
      const confirmAgain = await call('post', `${ROOT}/${id}/confirm`);
      expect(confirmAgain.status).toBe(200);
      const state = await call('get', `${ROOT}/${id}`);
      expect(parse<StockReservationState>(state)).toMatchObject({ status: 'FULFILLED' });
      expect(await stock(HUB)).toBe(3);
      await expect(
        prisma.$executeRaw`UPDATE "catalog"."stock_reservations" SET "status" = 'RELEASED', "released_at" = now() WHERE "id" = ${id}::uuid`,
      ).rejects.toThrow();
    });

    it('DT08-12/13: old CONFIRMED reservations appear in the report until they are fulfilled; the monitor never releases them', async () => {
      const old = await confirmed(HUB);
      const recent = await confirmed(PAD);
      await ageConfirmation(old, 600);
      const report = parse<UnfulfilledReservationsReport>(
        await call('get', `${ROOT}/unfulfilled?olderThanSeconds=300&limit=10`).expect(200),
      );
      expect(report.total).toBe(1);
      expect(report.items).toEqual([
        {
          reservationId: old,
          confirmedAt: expect.any(String) as string,
          ageSeconds: expect.any(Number) as number,
        },
      ]);
      expect(report.items[0]!.ageSeconds).toBeGreaterThanOrEqual(600);
      expect(report.oldestConfirmedAt).toBe(report.items[0]!.confirmedAt);
      // El reporte no expone líneas, precios ni datos de usuarios.
      expect(Object.keys(report.items[0]!).sort()).toEqual([
        'ageSeconds',
        'confirmedAt',
        'reservationId',
      ]);

      const all = parse<UnfulfilledReservationsReport>(
        await call('get', `${ROOT}/unfulfilled?olderThanSeconds=0`).expect(200),
      );
      expect(all.items.map((item) => item.reservationId)).toEqual([old, recent]);

      const monitored = await monitor.runOnce();
      expect(monitored?.items.map((item) => item.reservationId)).toEqual([old]);
      expect(await row(old)).toMatchObject({ status: 'CONFIRMED' });
      expect(await stock(HUB)).toBe(4);

      await fulfill(old, { orderId: randomUUID() });
      const after = parse<UnfulfilledReservationsReport>(
        await call('get', `${ROOT}/unfulfilled?olderThanSeconds=300`).expect(200),
      );
      expect(after).toEqual({ total: 0, oldestConfirmedAt: null, items: [] });
    });

    it('DT08-15/16/17: inventory-scoped token, public listener 404 and strict validation', async () => {
      const id = await confirmed(HUB);
      const body = { orderId: randomUUID() };
      expect((await supertest(server).post(`${ROOT}/${id}/fulfill`).send(body)).status).toBe(503);
      const shared = (process.env.SPECTRA_INTERNAL_TOKENS ?? '').split(',')[0]!.trim();
      const readScope = await supertest(server)
        .post(`${ROOT}/${id}/fulfill`)
        .set('X-Spectra-Internal-Token', shared)
        .send(body);
      expect(readScope.status).toBe(503);
      expect(
        (await supertest(server).get(`${ROOT}/unfulfilled`).set('X-Spectra-Internal-Token', shared))
          .status,
      ).toBe(503);

      const publicServer = publicApp.getHttpServer() as Server;
      await supertest(publicServer)
        .post(`${ROOT}/${id}/fulfill`)
        .set('X-Spectra-Internal-Token', token)
        .send(body)
        .expect(404);
      await supertest(publicServer)
        .get(`${ROOT}/unfulfilled`)
        .set('X-Spectra-Internal-Token', token)
        .expect(404);

      for (const invalid of [
        {},
        { orderId: 'not-a-uuid' },
        { orderId: body.orderId, status: 'FULFILLED' },
        { orderId: body.orderId, reservationId: id },
      ]) {
        expect((await fulfill(id, invalid)).status).toBe(400);
      }
      expect((await fulfill('not-a-uuid', body)).status).toBe(400);
      for (const query of [
        'olderThanSeconds=-1',
        'limit=0',
        'limit=101',
        'olderThanSeconds=x',
        'extra=1',
      ]) {
        expect((await call('get', `${ROOT}/unfulfilled?${query}`)).status).toBe(400);
      }
      expect(await row(id)).toMatchObject({ status: 'CONFIRMED', orderId: null });
    });
  },
);
