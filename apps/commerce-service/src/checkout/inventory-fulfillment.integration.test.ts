import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { Logger, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type {
  CheckoutSummary,
  OrderConfirmation,
  UnfulfilledReservationsReport,
} from '@spectra/contracts';
import cookieParser from 'cookie-parser';
import { Pool } from 'pg';
import supertest, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FaultProxy } from '../test-support/fault-proxy.js';
import { ORIGIN, SyntheticBuyer } from '../test-support/identity-agents.js';

// DT-08 (M06.0): reconocimiento FULFILLED tras C3, reintentos, recuperación y detección.
// Producto del seed que ninguna otra suite modifica; se restaura al final.
const EARBUDS = '20000000-0000-4000-8000-000000000011';
const FULFILL = /^POST \/internal\/catalog\/stock-reservations\/[0-9a-f-]+\/fulfill$/;
const SHIPPING = {
  recipientName: 'Comprador Entrega',
  phone: '5555-0102',
  department: 'Guatemala',
  municipality: 'Mixco',
  address: 'Calle ficticia 8-90, zona 8',
};

type FulfillmentRecovery = InstanceType<
  typeof import('./inventory-fulfillment-recovery.service.js').InventoryFulfillmentRecoveryService
>;
type Fulfillment = InstanceType<
  typeof import('./inventory-fulfillment.service.js').InventoryFulfillmentService
>;

function parse<T>(response: Response): T {
  return JSON.parse(response.text) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(!process.env.COMMERCE_DATABASE_URL)(
  'DT-08 inventory fulfillment with real Identity, Catalog (HTTP) and PostgreSQL',
  () => {
    let app: INestApplication;
    let server: Server;
    let prisma: import('../generated/commerce-client/index.js').PrismaClient;
    let recovery: FulfillmentRecovery;
    let fulfillment: Fulfillment;
    let config: typeof import('../config/commerce.config.js').commerceConfig;
    let catalogDb: Pool;
    let identityDb: Pool;
    let proxy: FaultProxy;
    let proxyUrl: URL;
    let privateKey: string;
    let cookieNames: { access: string; csrf: string };
    let original: { price: string; stock: number; is_active: boolean };
    const defaults: Partial<Record<string, number>> = {};

    async function boot(): Promise<{
      app: INestApplication;
      recovery: FulfillmentRecovery;
      fulfillment: Fulfillment;
    }> {
      const [{ AppModule }, recoveryModule, fulfillmentModule] = await Promise.all([
        import('../app.module.js'),
        import('./inventory-fulfillment-recovery.service.js'),
        import('./inventory-fulfillment.service.js'),
      ]);
      const instance = (
        await Test.createTestingModule({ imports: [AppModule] }).compile()
      ).createNestApplication();
      instance.use(cookieParser());
      instance.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
          stopAtFirstError: true,
        }),
      );
      await instance.init();
      return {
        app: instance,
        recovery: instance.get(recoveryModule.InventoryFulfillmentRecoveryService),
        fulfillment: instance.get(fulfillmentModule.InventoryFulfillmentService),
      };
    }

    async function checkout(): Promise<{
      order: OrderConfirmation;
      attemptId: string;
      reservationId: string;
    }> {
      const who = await SyntheticBuyer.provision(identityDb, privateKey, cookieNames);
      const csrf = await who.csrf();
      const added = await supertest(server)
        .post('/cart/items')
        .set('Cookie', who.cookieHeader())
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', csrf)
        .send({ productId: EARBUDS, quantity: 2 });
      expect(added.status).toBe(200);
      const summary = parse<CheckoutSummary>(
        await supertest(server).get('/checkout/summary').set('Cookie', who.cookieHeader()),
      );
      const response = await supertest(server)
        .post('/orders')
        .set('Cookie', who.cookieHeader())
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', csrf)
        .set('Idempotency-Key', randomUUID())
        .send({
          ...SHIPPING,
          simulatedPaymentResult: 'APROBADO',
          cartFingerprint: summary.fingerprint,
        });
      // El reconocimiento nunca altera la respuesta del checkout: el pedido siempre se confirma.
      expect(response.status).toBe(201);
      const order = parse<OrderConfirmation>(response);
      const attempt = await prisma.checkoutAttempt.findFirstOrThrow({
        where: { orderId: order.id },
      });
      return { order, attemptId: attempt.id, reservationId: attempt.reservationId };
    }

    async function reservation(id: string) {
      return (
        await catalogDb.query<{
          status: string;
          order_id: string | null;
          fulfilled_at: Date | null;
        }>('SELECT status, order_id, fulfilled_at FROM catalog.stock_reservations WHERE id = $1', [
          id,
        ])
      ).rows[0];
    }

    async function stock(): Promise<number> {
      return (
        await catalogDb.query<{ stock: number }>(
          'SELECT stock FROM catalog.products WHERE id = $1',
          [EARBUDS],
        )
      ).rows[0]!.stock;
    }

    async function attempt(id: string) {
      return prisma.checkoutAttempt.findUniqueOrThrow({ where: { id } });
    }

    async function waitUntilDue(id: string): Promise<void> {
      const wait = ((await attempt(id)).fulfillmentNextAttemptAt?.getTime() ?? 0) - Date.now();
      if (wait > 0) await sleep(wait + 20);
    }

    async function report(): Promise<UnfulfilledReservationsReport> {
      const response = await fetch(
        new URL(
          '/internal/catalog/stock-reservations/unfulfilled?olderThanSeconds=0',
          process.env.CATALOG_INTERNAL_URL,
        ),
        { headers: { 'X-Spectra-Internal-Token': process.env.CATALOG_INVENTORY_TOKEN! } },
      );
      expect(response.status).toBe(200);
      return (await response.json()) as UnfulfilledReservationsReport;
    }

    beforeAll(async () => {
      catalogDb = new Pool({ connectionString: process.env.CATALOG_TEST_DATABASE_URL });
      identityDb = new Pool({ connectionString: process.env.IDENTITY_TEST_DATABASE_URL });
      privateKey = await readFile(process.env.IDENTITY_TEST_PRIVATE_KEY_PATH!, 'utf8');
      original = (
        await catalogDb.query<{ price: string; stock: number; is_active: boolean }>(
          'SELECT price::text AS price, stock, is_active FROM catalog.products WHERE id = $1',
          [EARBUDS],
        )
      ).rows[0]!;
      const configModule = await import('../config/commerce.config.js');
      config = configModule.commerceConfig;
      cookieNames = {
        access: configModule.accessCookieName(),
        csrf: configModule.csrfCookieName(),
      };
      for (const name of [
        'recoveryIntervalMs',
        'fulfillmentIntervalMs',
        'fulfillmentBackoffBaseMs',
        'fulfillmentBackoffMaxMs',
        'fulfillmentStuckAttempts',
        'fulfillmentStuckAgeMs',
        'checkoutAttemptsPerMinute',
      ] as const) {
        defaults[name] = config[name];
      }
      proxy = new FaultProxy(new URL(process.env.CATALOG_INTERNAL_URL!));
      proxyUrl = await proxy.start();
      config.catalogUrl = proxyUrl;
      config.recoveryIntervalMs = 0;
      config.fulfillmentIntervalMs = 0;
      config.checkoutAttemptsPerMinute = 1_000;
      ({ app, recovery, fulfillment } = await boot());
      server = app.getHttpServer() as Server;
      prisma = (await import('../test-support/fixture-client.js')).createFixtureClient();
    });

    beforeEach(async () => {
      proxy.reset();
      config.catalogUrl = proxyUrl;
      config.fulfillmentBackoffBaseMs = 50;
      config.fulfillmentBackoffMaxMs = 400;
      config.fulfillmentStuckAttempts = 5;
      config.fulfillmentStuckAgeMs = 3_600_000;
      await prisma.orderItem.deleteMany();
      await prisma.order.deleteMany();
      await prisma.checkoutAttempt.deleteMany();
      await prisma.outboxEvent.deleteMany();
      await prisma.cartItem.deleteMany();
      await prisma.cart.deleteMany();
      await catalogDb.query('DELETE FROM catalog.stock_reservation_lines');
      await catalogDb.query('DELETE FROM catalog.stock_reservations');
      await catalogDb.query(
        'UPDATE catalog.products SET price = $1, stock = $2, is_active = true WHERE id = $3',
        ['299.00', 10, EARBUDS],
      );
    });

    afterAll(async () => {
      Object.assign(config, defaults);
      await app?.close();
      await prisma?.$disconnect();
      await proxy?.stop();
      if (catalogDb && original) {
        await catalogDb.query('DELETE FROM catalog.stock_reservation_lines');
        await catalogDb.query('DELETE FROM catalog.stock_reservations');
        await catalogDb.query(
          'UPDATE catalog.products SET price = $1, stock = $2, is_active = $3 WHERE id = $4',
          [original.price, original.stock, original.is_active, EARBUDS],
        );
      }
      await Promise.all([catalogDb?.end(), identityDb?.end()]);
    });

    it('DT08-1: a completed checkout ends with a FULFILLED reservation linked to the same order', async () => {
      const { order, attemptId, reservationId } = await checkout();
      expect(await reservation(reservationId)).toMatchObject({
        status: 'FULFILLED',
        order_id: order.id,
      });
      const stored = await attempt(attemptId);
      expect(stored.inventoryFulfilledAt).toBeInstanceOf(Date);
      expect(stored).toMatchObject({
        state: 'COMPLETED',
        fulfillmentAttempts: 0,
        fulfillmentLastError: null,
        fulfillmentLeaseOwner: null,
      });
      expect(await stock()).toBe(8);
      expect((await report()).total).toBe(0);
    });

    it('DT08-7: Catalog applies fulfill but the response is lost; the retry converges with 200', async () => {
      proxy.on(FULFILL, { kind: 'fail-after' });
      const { order, attemptId, reservationId } = await checkout();
      expect(await reservation(reservationId)).toMatchObject({
        status: 'FULFILLED',
        order_id: order.id,
      });
      const pending = await attempt(attemptId);
      expect(pending).toMatchObject({
        inventoryFulfilledAt: null,
        fulfillmentAttempts: 1,
        fulfillmentLastError: 'INVENTORY_UNAVAILABLE',
        fulfillmentLeaseOwner: null,
      });
      const firstFulfilledAt = (await reservation(reservationId))!.fulfilled_at!.getTime();

      proxy.reset();
      await waitUntilDue(attemptId);
      const run = await recovery.runOnce();
      expect(run.outcomes.FULFILLED).toBe(1);
      expect((await attempt(attemptId)).inventoryFulfilledAt).toBeInstanceOf(Date);
      expect((await reservation(reservationId))!.fulfilled_at!.getTime()).toBe(firstFulfilledAt);
      expect(await stock()).toBe(8);
      expect(await prisma.order.count()).toBe(1);
    });

    it('DT08-8/13: Catalog unavailable after C3 keeps one order, the stock deducted once and acknowledges later', async () => {
      proxy.on(FULFILL, { kind: 'fail-before' });
      const { order, attemptId, reservationId } = await checkout();
      expect(await reservation(reservationId)).toMatchObject({
        status: 'CONFIRMED',
        order_id: null,
      });
      expect(await stock()).toBe(8);
      expect((await report()).items.map((item) => item.reservationId)).toEqual([reservationId]);
      const metrics = (await recovery.runOnce()).metrics;
      expect(metrics).toMatchObject({ pending: 1, stuck: 0 });

      proxy.reset();
      await waitUntilDue(attemptId);
      expect((await recovery.runOnce()).outcomes.FULFILLED).toBe(1);
      expect(await reservation(reservationId)).toMatchObject({
        status: 'FULFILLED',
        order_id: order.id,
      });
      expect((await report()).total).toBe(0);
      expect(await prisma.order.count()).toBe(1);
      expect(await stock()).toBe(8);
    });

    it('DT08-9: Commerce stops right after C3; a restarted process acknowledges on startup', async () => {
      proxy.on(FULFILL, { kind: 'fail-before' });
      const { attemptId, reservationId } = await checkout();
      // Simula la caída: el proceso murió con el arrendamiento tomado y sin registrar nada.
      await prisma.checkoutAttempt.update({
        where: { id: attemptId },
        data: {
          fulfillmentAttempts: 0,
          fulfillmentNextAttemptAt: null,
          fulfillmentLastError: null,
          fulfillmentLeaseOwner: randomUUID(),
          fulfillmentLeaseUntil: new Date(Date.now() - 1_000),
        },
      });
      proxy.reset();
      const restarted = await boot();
      try {
        for (let i = 0; i < 50 && !(await attempt(attemptId)).inventoryFulfilledAt; i += 1) {
          await sleep(100);
        }
        expect((await attempt(attemptId)).inventoryFulfilledAt).toBeInstanceOf(Date);
        expect((await reservation(reservationId))!.status).toBe('FULFILLED');
        expect(await stock()).toBe(8);
      } finally {
        await restarted.app.close();
      }
    });

    it('DT08-10: two replicas compete through the lease and a stale owner cannot write', async () => {
      proxy.on(FULFILL, { kind: 'fail-before' });
      const { attemptId, reservationId } = await checkout();
      proxy.reset();
      await waitUntilDue(attemptId);
      expect(await fulfillment.fulfill(attemptId, randomUUID(), randomUUID())).toBe('SKIPPED');
      expect((await attempt(attemptId)).inventoryFulfilledAt).toBeNull();

      proxy.on(FULFILL, { kind: 'forward' });
      const replica = await boot();
      try {
        const [first, second] = await Promise.all([recovery.runOnce(), replica.recovery.runOnce()]);
        expect(first.outcomes.FULFILLED + second.outcomes.FULFILLED).toBe(1);
        expect(proxy.hits(FULFILL)).toBe(1);
        expect((await reservation(reservationId))!.status).toBe('FULFILLED');
        expect((await attempt(attemptId)).inventoryFulfilledAt).toBeInstanceOf(Date);
      } finally {
        await replica.app.close();
      }
    });

    it('DT08-11/14/18: five failures raise a single stuck alert, nothing is released and logs carry no secrets', async () => {
      const lines: string[] = [];
      const spies = (['log', 'warn', 'error'] as const).map((level) =>
        vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
          lines.push(JSON.stringify(args));
        }),
      );
      try {
        proxy.on(FULFILL, { kind: 'fail-before' });
        const { order, attemptId, reservationId } = await checkout();
        config.catalogUrl = new URL('http://127.0.0.1:9');
        for (let run = 0; run < 6; run += 1) {
          await waitUntilDue(attemptId);
          await recovery.runOnce();
        }
        const stuck = await attempt(attemptId);
        expect(stuck.fulfillmentAttempts).toBeGreaterThanOrEqual(5);
        expect(stuck.fulfillmentStuckSince).toBeInstanceOf(Date);
        expect(stuck.fulfillmentLastError).toBe('INVENTORY_UNAVAILABLE');
        const alerts = await prisma.outboxEvent.findMany({
          where: { eventType: 'INVENTORY_FULFILLMENT_STUCK' },
        });
        expect(alerts).toHaveLength(1);
        expect(alerts[0]!.metadata).toMatchObject({
          orderId: order.id,
          lastError: 'INVENTORY_UNAVAILABLE',
        });
        // Ni el pedido ni el stock cambian: la reserva sigue confirmada (nunca se libera).
        expect(await reservation(reservationId)).toMatchObject({ status: 'CONFIRMED' });
        expect(await stock()).toBe(8);
        expect(await prisma.order.count()).toBe(1);

        config.catalogUrl = proxyUrl;
        proxy.reset();
        await waitUntilDue(attemptId);
        const healed = await recovery.runOnce();
        expect(healed.outcomes.FULFILLED).toBe(1);
        expect(healed.metrics).toMatchObject({ pending: 0, stuck: 0 });
        expect(
          await prisma.outboxEvent.count({
            where: { eventType: 'INVENTORY_FULFILLMENT_RECOVERED' },
          }),
        ).toBe(1);
        expect(
          await prisma.outboxEvent.count({ where: { eventType: 'INVENTORY_FULFILLMENT_STUCK' } }),
        ).toBe(1);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      const logged = lines.join('\n');
      expect(logged).toContain('inventory_fulfillment_stuck');
      for (const secret of [
        config.inventoryToken,
        config.internalToken,
        SHIPPING.address,
        SHIPPING.phone,
        'Cookie',
        'postgresql://',
      ]) {
        expect(logged).not.toContain(secret);
      }
    });

    it('DT08-4/5 from Commerce: a semantic conflict is flagged stuck at once and never touches inventory', async () => {
      proxy.on(FULFILL, { kind: 'fail-before' });
      const { attemptId, reservationId } = await checkout();
      // Otro pedido ya quedó vinculado a la reserva (inconsistencia que requiere intervención).
      const foreignOrder = randomUUID();
      await catalogDb.query(
        `UPDATE catalog.stock_reservations SET status = 'FULFILLED', order_id = $1, fulfilled_at = now() WHERE id = $2`,
        [foreignOrder, reservationId],
      );
      proxy.reset();
      await waitUntilDue(attemptId);
      const run = await recovery.runOnce();
      expect(run.outcomes.STUCK).toBe(1);
      expect(await attempt(attemptId)).toMatchObject({
        inventoryFulfilledAt: null,
        fulfillmentLastError: 'ORDER_RESERVATION_MISMATCH',
      });
      expect((await attempt(attemptId)).fulfillmentStuckSince).toBeInstanceOf(Date);
      expect(await reservation(reservationId)).toMatchObject({
        status: 'FULFILLED',
        order_id: foreignOrder,
      });
      expect(await stock()).toBe(8);
      expect(
        await prisma.outboxEvent.count({ where: { eventType: 'INVENTORY_FULFILLMENT_STUCK' } }),
      ).toBe(1);
      // La detección periódica no vuelve a alertar.
      await recovery.runOnce();
      expect(
        await prisma.outboxEvent.count({ where: { eventType: 'INVENTORY_FULFILLMENT_STUCK' } }),
      ).toBe(1);
    });
  },
);
