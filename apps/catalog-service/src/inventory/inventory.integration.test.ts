import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { StockReservation, StockReservationState } from '@spectra/contracts';
import supertest, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Productos del seed que las pruebas M01 no inspeccionan; se restauran al terminar.
const HUB = '20000000-0000-4000-8000-000000000006';
const PAD = '20000000-0000-4000-8000-000000000010';
const CABLE = '20000000-0000-4000-8000-000000000013';
const PRODUCTS = [HUB, PAD, CABLE];
const BASE: Record<string, { price: string; stock: number }> = {
  [HUB]: { price: '275.00', stock: 5 },
  [PAD]: { price: '120.00', stock: 3 },
  [CABLE]: { price: '45.50', stock: 1 },
};

function parse<T>(response: Response): T {
  return JSON.parse(response.text) as T;
}

describe.skipIf(!process.env.DATABASE_URL || !process.env.CATALOG_INVENTORY_TOKENS)(
  'M04 inventory reservations with PostgreSQL (internal listener)',
  () => {
    let app: INestApplication;
    let publicApp: INestApplication;
    let server: Server;
    // DT-09: cliente de fixtures separado (rol migrador); la aplicación usa el rol de ejecución.
    let prisma: import('@prisma/client').PrismaClient;
    let sweeper: InstanceType<
      typeof import('./reservation-sweeper.service.js').ReservationSweeperService
    >;
    let token: string;
    let original: { id: string; price: string; stock: number; isActive: boolean }[];

    const line = (
      productId: string,
      quantity: number,
      expectedUnitPrice = BASE[productId]!.price,
    ) => ({
      productId,
      quantity,
      expectedUnitPrice,
    });

    function reserve(lines: ReturnType<typeof line>[], reservationId: string = randomUUID()) {
      return supertest(server)
        .post('/internal/catalog/stock-reservations')
        .set('X-Spectra-Internal-Token', token)
        .send({ reservationId, lines });
    }

    function call(method: 'get' | 'post', path: string) {
      return supertest(server)[method](path).set('X-Spectra-Internal-Token', token);
    }

    async function stock(id: string): Promise<number> {
      return (await prisma.product.findUniqueOrThrow({ where: { id } })).stock;
    }

    beforeAll(async () => {
      process.env.RESERVATION_SWEEP_INTERVAL_MS = '0';
      token = process.env.CATALOG_INVENTORY_TOKENS!.split(',')[0]!.trim();
      const [{ InternalAppModule }, { AppModule }, fixtureModule, sweeperModule] =
        await Promise.all([
          import('../internal-app.module.js'),
          import('../app.module.js'),
          import('../test-support/fixture-client.js'),
          import('./reservation-sweeper.service.js'),
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
      sweeper = app.get(sweeperModule.ReservationSweeperService);
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

    it('reserves all lines atomically, freezing prices and deducting stock', async () => {
      const response = await reserve([line(HUB, 2), line(PAD, 1)]);
      expect(response.status).toBe(201);
      const body = parse<StockReservation>(response);
      expect(body.status).toBe('PENDING');
      expect(body.lines).toEqual(
        expect.arrayContaining([
          { productId: HUB, name: expect.any(String) as string, quantity: 2, unitPrice: '275.00' },
          { productId: PAD, name: expect.any(String) as string, quantity: 1, unitPrice: '120.00' },
        ]),
      );
      expect(await stock(HUB)).toBe(3);
      expect(await stock(PAD)).toBe(2);
    });

    it('is all-or-nothing: one insufficient line rolls back every deduction and reports each conflict', async () => {
      await prisma.product.update({ where: { id: CABLE }, data: { isActive: false } });
      const response = await reserve([line(HUB, 2), line(PAD, 4), line(CABLE, 1)]);
      expect(response.status).toBe(409);
      expect(parse<{ code: string; conflicts: unknown[] }>(response)).toEqual({
        code: 'STOCK_CONFLICT',
        conflicts: expect.arrayContaining([
          { productId: PAD, reason: 'INSUFFICIENT_STOCK', available: 3 },
          { productId: CABLE, reason: 'INACTIVE', available: 0 },
        ]) as unknown[],
      });
      expect(await stock(HUB)).toBe(5);
      expect(await stock(PAD)).toBe(3);
      expect(await prisma.stockReservation.count()).toBe(0);
    });

    it('detects a price change inside the reservation transaction', async () => {
      const response = await reserve([line(HUB, 1, '274.99')]);
      expect(response.status).toBe(409);
      expect(parse<{ conflicts: unknown[] }>(response).conflicts).toEqual([
        { productId: HUB, reason: 'PRICE_CHANGED', available: 5 },
      ]);
      expect(await stock(HUB)).toBe(5);
    });

    it('is idempotent by reservation id and rejects a different payload for the same id', async () => {
      const id = randomUUID();
      expect((await reserve([line(HUB, 2)], id)).status).toBe(201);
      const replay = await reserve([line(HUB, 2)], id);
      expect(replay.status).toBe(200);
      expect(parse<StockReservation>(replay).reservationId).toBe(id);
      expect(await stock(HUB)).toBe(3);
      const mismatch = await reserve([line(HUB, 3)], id);
      expect(mismatch.status).toBe(409);
      expect(parse<{ code: string }>(mismatch).code).toBe('RESERVATION_MISMATCH');
      expect(await stock(HUB)).toBe(3);
    });

    it('prevents overselling under concurrency: 20 buyers, 5 units, and 2 buyers for the last unit', async () => {
      const results = await Promise.all(Array.from({ length: 20 }, () => reserve([line(HUB, 1)])));
      expect(results.filter((response) => response.status === 201)).toHaveLength(5);
      expect(results.filter((response) => response.status === 409)).toHaveLength(15);
      expect(await stock(HUB)).toBe(0);

      const last = await Promise.all([reserve([line(CABLE, 1)]), reserve([line(CABLE, 1)])]);
      expect(last.map((response) => response.status).sort()).toEqual([201, 409]);
      expect(await stock(CABLE)).toBe(0);
    });

    it('confirms idempotently; a confirmed reservation can no longer be released', async () => {
      const id = randomUUID();
      await reserve([line(PAD, 2)], id);
      const confirmed = await call('post', `/internal/catalog/stock-reservations/${id}/confirm`);
      expect(confirmed.status).toBe(200);
      expect(parse<StockReservation>(confirmed).status).toBe('CONFIRMED');
      expect(
        (await call('post', `/internal/catalog/stock-reservations/${id}/confirm`)).status,
      ).toBe(200);
      const release = await call('post', `/internal/catalog/stock-reservations/${id}/release`);
      expect(release.status).toBe(409);
      expect(parse<{ code: string }>(release).code).toBe('RESERVATION_CONFIRMED');
      expect(await stock(PAD)).toBe(1);
    });

    it('releases (compensates) exactly once and refuses a later confirmation', async () => {
      const id = randomUUID();
      await reserve([line(PAD, 2), line(HUB, 1)], id);
      const releases = await Promise.all([
        call('post', `/internal/catalog/stock-reservations/${id}/release`),
        call('post', `/internal/catalog/stock-reservations/${id}/release`),
      ]);
      expect(releases.map((response) => response.status)).toEqual([200, 200]);
      expect(await stock(PAD)).toBe(3);
      expect(await stock(HUB)).toBe(5);
      const confirm = await call('post', `/internal/catalog/stock-reservations/${id}/confirm`);
      expect(confirm.status).toBe(409);
      expect(parse<{ code: string }>(confirm).code).toBe('RESERVATION_RELEASED');
    });

    it('releasing an unknown id leaves a tombstone that blocks a late reservation', async () => {
      const id = randomUUID();
      const released = await call('post', `/internal/catalog/stock-reservations/${id}/release`);
      expect(parse<StockReservationState>(released).status).toBe('RELEASED');
      const late = await reserve([line(HUB, 1)], id);
      expect(late.status).toBe(409);
      expect(parse<{ code: string }>(late).code).toBe('RESERVATION_RELEASED');
      expect(await stock(HUB)).toBe(5);
    });

    it('expired reservations cannot be confirmed and are recovered by the sweeper', async () => {
      const expiring = randomUUID();
      const sweptLater = randomUUID();
      const fresh = randomUUID();
      await reserve([line(HUB, 2)], expiring);
      await reserve([line(PAD, 1)], sweptLater);
      await reserve([line(CABLE, 1)], fresh);
      await prisma.$executeRaw`
        UPDATE "catalog"."stock_reservations" SET "expires_at" = now() - interval '1 second'
         WHERE "id" IN (${expiring}::uuid, ${sweptLater}::uuid)`;

      const confirm = await call(
        'post',
        `/internal/catalog/stock-reservations/${expiring}/confirm`,
      );
      expect(confirm.status).toBe(409);
      expect(await stock(HUB)).toBe(5);

      // El barrido del contenedor catalog-service también puede liberarla antes; el resultado es el mismo.
      expect(await sweeper.runOnce()).toBeLessThanOrEqual(1);
      expect(await stock(PAD)).toBe(3);
      const state = await call('get', `/internal/catalog/stock-reservations/${sweptLater}`);
      expect(parse<StockReservationState>(state)).toMatchObject({ status: 'RELEASED' });
      const untouched = await call('get', `/internal/catalog/stock-reservations/${fresh}`);
      expect(parse<StockReservationState>(untouched)).toMatchObject({
        status: 'PENDING',
        expired: false,
      });
      expect(await stock(CABLE)).toBe(0);
    });

    it('enforces the inventory-scoped token, strict DTOs and is absent from the public listener', async () => {
      const body = { reservationId: randomUUID(), lines: [line(HUB, 1)] };
      const anonymous = await supertest(server)
        .post('/internal/catalog/stock-reservations')
        .send(body);
      expect(anonymous.status).toBe(503);
      const shared = (process.env.SPECTRA_INTERNAL_TOKENS ?? '').split(',')[0]!.trim();
      const wrongScope = await supertest(server)
        .post('/internal/catalog/stock-reservations')
        .set('X-Spectra-Internal-Token', shared)
        .send(body);
      expect(wrongScope.status).toBe(503);
      for (const invalid of [
        { ...body, lines: [{ ...line(HUB, 11) }] },
        { ...body, lines: [{ ...line(HUB, 1), price: '0.01' }] },
        { ...body, lines: [line(HUB, 1), line(HUB, 1)] },
        { ...body, lines: [] },
        { ...body, reservationId: 'not-a-uuid' },
      ]) {
        expect(
          (await reserve(invalid.lines as ReturnType<typeof line>[], invalid.reservationId)).status,
        ).toBe(400);
      }
      expect(await stock(HUB)).toBe(5);
      const publicServer = publicApp.getHttpServer() as Server;
      await supertest(publicServer)
        .post('/internal/catalog/stock-reservations')
        .set('X-Spectra-Internal-Token', token)
        .send(body)
        .expect(404);
    });

    it('keeps the CHECK stock >= 0 as last line of defence', async () => {
      await expect(
        prisma.$executeRaw`UPDATE "catalog"."products" SET "stock" = -1 WHERE "id" = ${HUB}::uuid`,
      ).rejects.toThrow();
    });
  },
);
