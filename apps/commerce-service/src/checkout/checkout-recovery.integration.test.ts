import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { ApiErrorResponse, CheckoutSummary, OrderConfirmation } from '@spectra/contracts';
import cookieParser from 'cookie-parser';
import { Pool } from 'pg';
import supertest, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FaultProxy } from '../test-support/fault-proxy.js';
import { ORIGIN, SyntheticBuyer } from '../test-support/identity-agents.js';

// Producto sintético del seed M01 no inspeccionado por M01/M03; se restaura al final.
const LAMP = '20000000-0000-4000-8000-000000000009';
const CONFIRM = /^POST \/internal\/catalog\/stock-reservations\/[0-9a-f-]+\/confirm$/;
const SHIPPING = {
  recipientName: 'Comprador Recuperacion',
  phone: '5555-0101',
  department: 'Guatemala',
  municipality: 'Mixco',
  address: 'Calle ficticia 4-56, zona 4',
};

type Recovery = InstanceType<
  typeof import('./checkout-recovery.service.js').CheckoutRecoveryService
>;

function parse<T>(response: Response): T {
  return JSON.parse(response.text) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(!process.env.COMMERCE_DATABASE_URL)(
  'M04.1 saga recovery hardening with real Identity, Catalog (HTTP) and PostgreSQL',
  () => {
    let app: INestApplication;
    let server: Server;
    let prisma: InstanceType<typeof import('../database/prisma.service.js').PrismaService>;
    let recovery: Recovery;
    let config: typeof import('../config/commerce.config.js').commerceConfig;
    let helpers: typeof import('./checkout.service.js');
    let catalogDb: Pool;
    let identityDb: Pool;
    let proxy: FaultProxy;
    let proxyUrl: URL;
    let privateKey: string;
    let cookieNames: { access: string; csrf: string };
    let original: { price: string; stock: number; is_active: boolean };
    const defaults: Partial<Record<string, number>> = {};

    async function boot(): Promise<{ app: INestApplication; recovery: Recovery }> {
      const [{ AppModule }, recoveryModule] = await Promise.all([
        import('../app.module.js'),
        import('./checkout-recovery.service.js'),
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
      return { app: instance, recovery: instance.get(recoveryModule.CheckoutRecoveryService) };
    }

    async function buyer(): Promise<SyntheticBuyer> {
      return SyntheticBuyer.provision(identityDb, privateKey, cookieNames);
    }

    function placeOrder(who: SyntheticBuyer, csrf: string, key: string, fingerprint: string) {
      return supertest(server)
        .post('/orders')
        .set('Cookie', who.cookieHeader())
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', csrf)
        .set('Idempotency-Key', key)
        .send({ ...SHIPPING, simulatedPaymentResult: 'APROBADO', cartFingerprint: fingerprint });
    }

    /** Deja una saga pendiente: `confirmMode` decide si Catalog aplica o no la confirmación. */
    async function pendingSaga(
      who: SyntheticBuyer,
      confirmMode: 'fail-after' | 'fail-before',
    ): Promise<{ attemptId: string; reservationId: string; key: string; fingerprint: string }> {
      const csrf = await who.csrf();
      const added = await supertest(server)
        .post('/cart/items')
        .set('Cookie', who.cookieHeader())
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', csrf)
        .send({ productId: LAMP, quantity: 2 });
      expect(added.status).toBe(200);
      const summary = parse<CheckoutSummary>(
        await supertest(server).get('/checkout/summary').set('Cookie', who.cookieHeader()),
      );
      proxy.on(CONFIRM, { kind: confirmMode });
      const key = randomUUID();
      const response = await placeOrder(who, csrf, key, summary.fingerprint);
      expect(response.status).toBe(503);
      expect(parse<ApiErrorResponse>(response).code).toBe('CHECKOUT_PENDING');
      proxy.reset();
      const attempt = await prisma.checkoutAttempt.findFirstOrThrow({
        where: { userId: who.userId },
      });
      expect(attempt.state).toBe('RESERVED');
      return {
        attemptId: attempt.id,
        reservationId: attempt.reservationId,
        key,
        fingerprint: summary.fingerprint,
      };
    }

    async function stock(): Promise<number> {
      return (
        await catalogDb.query<{ stock: number }>(
          'SELECT stock FROM catalog.products WHERE id = $1',
          [LAMP],
        )
      ).rows[0]!.stock;
    }

    async function reservationStatus(reservationId: string): Promise<string | undefined> {
      return (
        await catalogDb.query<{ status: string }>(
          'SELECT status FROM catalog.stock_reservations WHERE id = $1',
          [reservationId],
        )
      ).rows[0]?.status;
    }

    /** Espera a que venza el backoff programado del intento. */
    async function waitUntilDue(attemptId: string): Promise<void> {
      const attempt = await prisma.checkoutAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      const wait = (attempt.nextRecoveryAt?.getTime() ?? 0) - Date.now();
      if (wait > 0) await sleep(wait + 20);
    }

    beforeAll(async () => {
      catalogDb = new Pool({ connectionString: process.env.CATALOG_TEST_DATABASE_URL });
      identityDb = new Pool({ connectionString: process.env.IDENTITY_TEST_DATABASE_URL });
      privateKey = await readFile(process.env.IDENTITY_TEST_PRIVATE_KEY_PATH!, 'utf8');
      original = (
        await catalogDb.query<{ price: string; stock: number; is_active: boolean }>(
          'SELECT price::text AS price, stock, is_active FROM catalog.products WHERE id = $1',
          [LAMP],
        )
      ).rows[0]!;
      const configModule = await import('../config/commerce.config.js');
      config = configModule.commerceConfig;
      helpers = await import('./checkout.service.js');
      cookieNames = {
        access: configModule.accessCookieName(),
        csrf: configModule.csrfCookieName(),
      };
      for (const name of [
        'recoveryIntervalMs',
        'recoveryBackoffBaseMs',
        'recoveryBackoffMaxMs',
        'stuckAgeMs',
        'stuckAttempts',
        'checkoutAttemptsPerMinute',
      ] as const) {
        defaults[name] = config[name];
      }
      proxy = new FaultProxy(new URL(process.env.CATALOG_INTERNAL_URL!));
      proxyUrl = await proxy.start();
      config.catalogUrl = proxyUrl;
      config.recoveryIntervalMs = 0;
      config.checkoutAttemptsPerMinute = 1_000;
      ({ app, recovery } = await boot());
      server = app.getHttpServer() as Server;
      prisma = app.get((await import('../database/prisma.service.js')).PrismaService);
    });

    beforeEach(async () => {
      proxy.reset();
      config.catalogUrl = proxyUrl;
      config.recoveryBackoffBaseMs = 50;
      config.recoveryBackoffMaxMs = 400;
      config.stuckAgeMs = 3_600_000;
      config.stuckAttempts = 3;
      await prisma.$executeRaw`DROP TRIGGER IF EXISTS m04_1_block_orders ON "commerce"."orders"`;
      await prisma.orderItem.deleteMany();
      await prisma.order.deleteMany();
      await prisma.checkoutAttempt.deleteMany();
      await prisma.outboxEvent.deleteMany();
      await prisma.cartItem.deleteMany();
      await prisma.cart.deleteMany();
      await catalogDb.query('DELETE FROM catalog.stock_reservation_lines');
      await catalogDb.query('DELETE FROM catalog.stock_reservations');
      await catalogDb.query(
        'UPDATE catalog.products SET price = $1, stock = 6, is_active = true WHERE id = $2',
        ['145.00', LAMP],
      );
    });

    afterAll(async () => {
      if (prisma) {
        await prisma.$executeRaw`DROP TRIGGER IF EXISTS m04_1_block_orders ON "commerce"."orders"`;
        await prisma.$executeRaw`DROP FUNCTION IF EXISTS "commerce"."m04_1_block_orders"()`;
      }
      Object.assign(config, defaults);
      await app?.close();
      await proxy?.stop();
      if (catalogDb && original) {
        await catalogDb.query('DELETE FROM catalog.stock_reservation_lines');
        await catalogDb.query('DELETE FROM catalog.stock_reservations');
        await catalogDb.query(
          'UPDATE catalog.products SET price = $1, stock = $2, is_active = $3 WHERE id = $4',
          [original.price, original.stock, original.is_active, LAMP],
        );
      }
      await Promise.all([catalogDb?.end(), identityDb?.end()]);
    });

    it('computes a bounded exponential backoff and whitelisted error codes', () => {
      config.recoveryBackoffBaseMs = 15_000;
      config.recoveryBackoffMaxMs = 900_000;
      expect([0, 1, 2, 3, 4, 7, 8, 50].map(helpers.recoveryBackoffMs)).toEqual([
        15_000, 15_000, 30_000, 60_000, 120_000, 900_000, 900_000, 900_000,
      ]);
      expect(helpers.recoveryErrorCode(new Error('x'))).toBe('UNEXPECTED_ERROR');
      const prismaLike = Object.assign(new Error('db'), { name: 'PrismaClientKnownRequestError' });
      expect(helpers.recoveryErrorCode(prismaLike)).toBe('PERSISTENCE_ERROR');
    });

    it('persistent failure after the point of no return: backoff, single alert, confirmed stock never released, then exactly one order', async () => {
      const who = await buyer();
      const { attemptId, reservationId, key, fingerprint } = await pendingSaga(who, 'fail-after');
      expect(await reservationStatus(reservationId)).toBe('CONFIRMED');
      expect(await stock()).toBe(4);

      // Fallo persistente y determinista de C3: toda inserción de pedidos falla.
      await prisma.$executeRaw`
        CREATE OR REPLACE FUNCTION "commerce"."m04_1_block_orders"() RETURNS trigger
        LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'synthetic persistent failure'; END $fn$`;
      await prisma.$executeRaw`
        CREATE TRIGGER m04_1_block_orders BEFORE INSERT ON "commerce"."orders"
        FOR EACH ROW EXECUTE FUNCTION "commerce"."m04_1_block_orders"()`;

      const delays: number[] = [];
      const alerts: (readonly string[])[] = [];
      for (let run = 1; run <= 5; run += 1) {
        await waitUntilDue(attemptId);
        const before = Date.now();
        const report = await recovery.runOnce();
        expect(report.outcomes.DEFERRED).toBe(1);
        alerts.push(report.newlyStuck);
        const attempt = await prisma.checkoutAttempt.findUniqueOrThrow({
          where: { id: attemptId },
        });
        expect(attempt).toMatchObject({
          state: 'CONFIRMED',
          recoveryAttempts: run,
          lastRecoveryError: 'PERSISTENCE_ERROR',
        });
        delays.push(attempt.nextRecoveryAt!.getTime() - before);

        // Dentro del backoff no hay reintento silencioso ni consumo de intentos.
        const idle = await recovery.runOnce();
        expect(idle.outcomes).toEqual({ SKIPPED: 0, COMPLETED: 0, ABORTED: 0, DEFERRED: 0 });
        expect(
          (await prisma.checkoutAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
            .recoveryAttempts,
        ).toBe(run);
      }
      // 50, 100, 200, 400, 400 ms (tope), con tolerancia de reloj.
      [50, 100, 200, 400, 400].forEach((expected, index) => {
        expect(delays[index]).toBeGreaterThanOrEqual(expected - 15);
        expect(delays[index]).toBeLessThanOrEqual(expected + 250);
      });
      // Alerta única al alcanzar 3 reintentos (CHECKOUT_STUCK_ATTEMPTS = 3).
      expect(alerts.map((ids) => ids.length)).toEqual([0, 0, 1, 0, 0]);
      const stuckEvents = await prisma.outboxEvent.findMany({
        where: { eventType: 'CHECKOUT_SAGA_STUCK' },
      });
      expect(stuckEvents).toHaveLength(1);
      expect(stuckEvents[0]).toMatchObject({ resourceId: attemptId, result: 'FALLO' });
      expect(stuckEvents[0]!.metadata).toMatchObject({
        state: 'CONFIRMED',
        pointOfNoReturn: 'yes',
        lastRecoveryError: 'PERSISTENCE_ERROR',
      });
      const metrics = (await recovery.runOnce()).metrics!;
      expect(metrics).toMatchObject({ stuck: 1, inflightTotal: 1, maxRecoveryAttempts: 5 });
      expect(metrics.inflight.CONFIRMED).toBe(1);

      // Nunca se abandona tras el punto de no retorno: reserva confirmada, stock descontado una vez.
      expect(await reservationStatus(reservationId)).toBe('CONFIRMED');
      expect(await stock()).toBe(4);
      expect(await prisma.order.count()).toBe(0);

      // Un reenvío del cliente durante el backoff no fuerza la recuperación.
      const attemptsBeforeReplay = (
        await prisma.checkoutAttempt.findUniqueOrThrow({ where: { id: attemptId } })
      ).recoveryAttempts;
      const csrf = await who.csrf();
      const replayDuringBackoff = await placeOrder(who, csrf, key, fingerprint);
      expect(replayDuringBackoff.status).toBe(503);
      expect(parse<ApiErrorResponse>(replayDuringBackoff).code).toBe('CHECKOUT_PENDING');
      expect(
        (await prisma.checkoutAttempt.findUniqueOrThrow({ where: { id: attemptId } }))
          .recoveryAttempts,
      ).toBe(attemptsBeforeReplay);

      // Se corrige la causa: la siguiente recuperación completa hacia adelante una sola vez.
      await prisma.$executeRaw`DROP TRIGGER m04_1_block_orders ON "commerce"."orders"`;
      await waitUntilDue(attemptId);
      const recovered = await recovery.runOnce();
      expect(recovered.outcomes.COMPLETED).toBe(1);
      expect(recovered.metrics).toMatchObject({ stuck: 0, inflightTotal: 0 });
      expect(await prisma.order.count()).toBe(1);
      expect(await stock()).toBe(4);
      const recoveredEvents = await prisma.outboxEvent.findMany({
        where: { eventType: 'CHECKOUT_SAGA_RECOVERED' },
      });
      expect(recoveredEvents).toHaveLength(1);
      expect(recoveredEvents[0]!.metadata).toMatchObject({ outcome: 'COMPLETED' });
      expect(await prisma.outboxEvent.count({ where: { eventType: 'ORDER_CREATED' } })).toBe(1);

      const replay = await placeOrder(who, await who.csrf(), key, fingerprint);
      expect(replay.status).toBe(200);
      const order = await prisma.order.findFirstOrThrow();
      expect(parse<OrderConfirmation>(replay).id).toBe(order.id);
    });

    it('persistent Catalog outage before the point of no return: age-based alert, then safe compensation', async () => {
      config.stuckAgeMs = 10;
      const who = await buyer();
      const { attemptId, reservationId } = await pendingSaga(who, 'fail-before');
      expect(await reservationStatus(reservationId)).toBe('PENDING');
      expect(await stock()).toBe(4);

      config.catalogUrl = new URL('http://127.0.0.1:9');
      await sleep(20);
      const first = await recovery.runOnce();
      expect(first.outcomes.DEFERRED).toBe(1);
      expect(first.newlyStuck).toEqual([attemptId]);
      const attempt = await prisma.checkoutAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      expect(attempt).toMatchObject({
        state: 'RESERVED',
        lastRecoveryError: 'INVENTORY_UNAVAILABLE',
      });
      const [alert] = await prisma.outboxEvent.findMany({
        where: { eventType: 'CHECKOUT_SAGA_STUCK' },
      });
      expect(alert!.metadata).toMatchObject({ state: 'RESERVED', pointOfNoReturn: 'unknown' });
      // Sin Catalog no se puede saber si la reserva fue confirmada: la saga se conserva.
      expect(await reservationStatus(reservationId)).toBe('PENDING');

      config.catalogUrl = proxyUrl;
      await waitUntilDue(attemptId);
      const second = await recovery.runOnce();
      expect(second.outcomes.ABORTED).toBe(1);
      expect(await reservationStatus(reservationId)).toBe('RELEASED');
      expect(await stock()).toBe(6);
      expect(await prisma.order.count()).toBe(0);
      const recovered = await prisma.outboxEvent.findMany({
        where: { eventType: 'CHECKOUT_SAGA_RECOVERED' },
      });
      expect(recovered[0]!.metadata).toMatchObject({ outcome: 'ABORTED' });
      expect(await prisma.outboxEvent.count({ where: { eventType: 'CHECKOUT_SAGA_STUCK' } })).toBe(
        1,
      );
    });

    it('two Commerce replicas and concurrent replays recover a confirmed saga into exactly one order', async () => {
      const who = await buyer();
      const { key, fingerprint } = await pendingSaga(who, 'fail-after');
      const replica = await boot();
      try {
        const csrf = await who.csrf();
        const results = await Promise.all([
          recovery.runOnce(),
          replica.recovery.runOnce(),
          placeOrder(who, csrf, key, fingerprint),
          placeOrder(who, csrf, key, fingerprint),
        ]);
        const completed = results[0].outcomes.COMPLETED + results[1].outcomes.COMPLETED;
        expect(completed).toBeLessThanOrEqual(1);
        expect(await prisma.order.count()).toBe(1);
        expect(await prisma.orderItem.count()).toBe(1);
        expect(await prisma.outboxEvent.count({ where: { eventType: 'ORDER_CREATED' } })).toBe(1);
        expect(await stock()).toBe(4);
        const final = await placeOrder(who, await who.csrf(), key, fingerprint);
        expect(final.status).toBe(200);
      } finally {
        await replica.app.close();
      }
    });

    it('DT-05: sensitive Commerce responses are never cached', async () => {
      const who = await buyer();
      const csrf = await who.csrf();
      const responses: Response[] = [];
      responses.push(
        await supertest(server)
          .post('/cart/items')
          .set('Cookie', who.cookieHeader())
          .set('Origin', ORIGIN)
          .set('X-CSRF-Token', csrf)
          .send({ productId: LAMP, quantity: 1 }),
      );
      responses.push(await supertest(server).get('/cart').set('Cookie', who.cookieHeader()));
      const summary = await supertest(server)
        .get('/checkout/summary')
        .set('Cookie', who.cookieHeader());
      responses.push(summary);
      const created = await placeOrder(
        who,
        csrf,
        randomUUID(),
        parse<CheckoutSummary>(summary).fingerprint,
      );
      expect(created.status).toBe(201);
      responses.push(created);
      responses.push(
        await supertest(server)
          .get(`/orders/${parse<OrderConfirmation>(created).id}`)
          .set('Cookie', who.cookieHeader()),
      );
      responses.push(
        await supertest(server).get(`/orders/${randomUUID()}`).set('Cookie', who.cookieHeader()),
      );
      responses.push(await supertest(server).get('/cart'));
      expect(responses.map((response) => response.status)).toEqual([
        200, 200, 200, 201, 200, 404, 401,
      ]);
      for (const response of responses) {
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['pragma']).toBe('no-cache');
      }
    });
  },
);
