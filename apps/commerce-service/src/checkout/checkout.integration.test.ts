import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type {
  ApiErrorResponse,
  CheckoutSummary,
  OrderConfirmation,
  ShoppingCart,
} from '@spectra/contracts';
import cookieParser from 'cookie-parser';
import { Pool } from 'pg';
import supertest, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FaultProxy } from '../test-support/fault-proxy.js';
import {
  type Buyer,
  IdentityAgent,
  ORIGIN,
  SyntheticBuyer,
} from '../test-support/identity-agents.js';

// Productos sintéticos del seed M01 que las pruebas M01/M03 no inspeccionan; se restauran al final.
const MOUSE = '20000000-0000-4000-8000-000000000005';
const STAND = '20000000-0000-4000-8000-000000000007';
const MIC = '20000000-0000-4000-8000-000000000008';
const CAMERA = '20000000-0000-4000-8000-000000000012';
const PRODUCTS = [MOUSE, STAND, MIC, CAMERA];
const BASELINE: Record<string, { price: string; stock: number }> = {
  [MOUSE]: { price: '150.00', stock: 5 },
  [STAND]: { price: '210.50', stock: 3 },
  [MIC]: { price: '499.99', stock: 5 },
  [CAMERA]: { price: '89.95', stock: 6 },
};

const SHIPPING = {
  recipientName: 'Ana Pérez Sintética',
  phone: '5555-0101',
  department: 'Guatemala',
  municipality: 'Mixco',
  address: 'Calle ficticia 1-23, zona 1',
  references: 'Portón azul ficticio',
};

const RESERVE = /^POST \/internal\/catalog\/stock-reservations$/;
const CONFIRM = /^POST \/internal\/catalog\/stock-reservations\/[0-9a-f-]+\/confirm$/;

function parse<T>(response: Response): T {
  return JSON.parse(response.text) as T;
}

function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    for (;;) {
      const value = await probe();
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw new Error('waitFor timeout');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
}

describe.skipIf(!process.env.COMMERCE_DATABASE_URL)(
  'M04 checkout saga with real Identity, Catalog (HTTP) and PostgreSQL',
  () => {
    let app: INestApplication;
    let server: Server;
    // DT-09: cliente de fixtures separado (rol migrador); la aplicación usa el rol de ejecución.
    let prisma: import('../generated/commerce-client/index.js').PrismaClient;
    let config: typeof import('../config/commerce.config.js').commerceConfig;
    let recovery: InstanceType<
      typeof import('./checkout-recovery.service.js').CheckoutRecoveryService
    >;
    let catalogDb: Pool;
    let identityDb: Pool;
    let proxy: FaultProxy;
    let proxyUrl: URL;
    let privateKey: string;
    let cookieNames: { access: string; csrf: string };
    let original: { id: string; price: string; stock: number; is_active: boolean }[];
    let ana: IdentityAgent;
    let bruno: IdentityAgent;
    let admin: IdentityAgent;

    async function boot(): Promise<void> {
      const [{ AppModule }, fixtureModule, recoveryModule] = await Promise.all([
        import('../app.module.js'),
        import('../test-support/fixture-client.js'),
        import('./checkout-recovery.service.js'),
      ]);
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
          stopAtFirstError: true,
        }),
      );
      await app.init();
      server = app.getHttpServer() as Server;
      prisma = fixtureModule.createFixtureClient();
      recovery = app.get(recoveryModule.CheckoutRecoveryService);
    }

    async function mutate(
      buyer: Buyer,
      method: 'post' | 'patch' | 'delete',
      path: string,
      body: Record<string, unknown> = {},
    ): Promise<Response> {
      const token = await buyer.csrf();
      return supertest(server)
        [method](path)
        .set('Cookie', buyer.cookieHeader())
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', token)
        .set('Content-Type', 'application/json')
        .send(body);
    }

    async function addToCart(buyer: Buyer, productId: string, quantity: number): Promise<void> {
      const response = await mutate(buyer, 'post', '/cart/items', { productId, quantity });
      expect(response.status).toBe(200);
    }

    async function summary(buyer: Buyer): Promise<CheckoutSummary> {
      const response = await supertest(server)
        .get('/checkout/summary')
        .set('Cookie', buyer.cookieHeader());
      expect(response.status).toBe(200);
      return parse<CheckoutSummary>(response);
    }

    function order(
      buyer: Buyer,
      csrf: string,
      key: string,
      body: Record<string, unknown>,
    ): supertest.Test {
      return supertest(server)
        .post('/orders')
        .set('Cookie', buyer.cookieHeader())
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', csrf)
        .set('Idempotency-Key', key)
        .set('Content-Type', 'application/json')
        .send(body);
    }

    async function place(
      buyer: Buyer,
      fingerprint: string,
      simulatedPaymentResult: 'APROBADO' | 'RECHAZADO' = 'APROBADO',
      key = randomUUID(),
    ): Promise<Response> {
      return order(buyer, await buyer.csrf(), key, {
        ...SHIPPING,
        simulatedPaymentResult,
        cartFingerprint: fingerprint,
      });
    }

    async function stock(productId: string): Promise<number> {
      const result = await catalogDb.query<{ stock: number }>(
        'SELECT stock FROM catalog.products WHERE id = $1',
        [productId],
      );
      return result.rows[0]!.stock;
    }

    async function reservation(reservationId: string): Promise<string | undefined> {
      const result = await catalogDb.query<{ status: string }>(
        'SELECT status FROM catalog.stock_reservations WHERE id = $1',
        [reservationId],
      );
      return result.rows[0]?.status;
    }

    async function attemptFor(userId: string) {
      return prisma.checkoutAttempt.findFirstOrThrow({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });
    }

    beforeAll(async () => {
      const suffix = randomUUID().slice(0, 8);
      ana = new IdentityAgent(`ana.checkout.${suffix}@example.test`, 'Nebula segura 2026!');
      bruno = new IdentityAgent(`bruno.checkout.${suffix}@example.test`, 'Prisma segura 2026!');
      admin = new IdentityAgent(
        `admin.checkout.${suffix}@example.test`,
        'Administrador seguro 2026!',
      );
      catalogDb = new Pool({ connectionString: process.env.CATALOG_TEST_DATABASE_URL });
      identityDb = new Pool({ connectionString: process.env.IDENTITY_TEST_DATABASE_URL });
      privateKey = await readFile(process.env.IDENTITY_TEST_PRIVATE_KEY_PATH!, 'utf8');
      await Promise.all([ana.register(), bruno.register(), admin.register()]);
      await identityDb.query(`UPDATE identity.users SET role_id = $1 WHERE email_normalized = $2`, [
        '10000000-0000-4000-8000-000000000002',
        admin.email,
      ]);
      await Promise.all([ana.login(), bruno.login(), admin.login()]);
      original = (
        await catalogDb.query<{ id: string; price: string; stock: number; is_active: boolean }>(
          'SELECT id, price::text AS price, stock, is_active FROM catalog.products WHERE id = ANY($1::uuid[])',
          [PRODUCTS],
        )
      ).rows;

      const configModule = await import('../config/commerce.config.js');
      config = configModule.commerceConfig;
      cookieNames = {
        access: configModule.accessCookieName(),
        csrf: configModule.csrfCookieName(),
      };
      proxy = new FaultProxy(new URL(process.env.CATALOG_INTERNAL_URL!));
      proxyUrl = await proxy.start();
      config.catalogUrl = proxyUrl;
      config.recoveryIntervalMs = 0;
      config.checkoutAttemptsPerMinute = 1_000;
      config.duplicateWaitMs = 10_000;
      await boot();
    });

    beforeEach(async () => {
      proxy.reset();
      config.catalogUrl = proxyUrl;
      await prisma.orderItem.deleteMany();
      await prisma.order.deleteMany();
      await prisma.checkoutAttempt.deleteMany();
      await prisma.outboxEvent.deleteMany();
      await prisma.cartItem.deleteMany();
      await prisma.cart.deleteMany();
      await catalogDb.query('DELETE FROM catalog.stock_reservation_lines');
      await catalogDb.query('DELETE FROM catalog.stock_reservations');
      for (const [id, values] of Object.entries(BASELINE)) {
        await catalogDb.query(
          'UPDATE catalog.products SET price = $1, stock = $2, is_active = true WHERE id = $3',
          [values.price, values.stock, id],
        );
      }
    });

    afterAll(async () => {
      if (app) await app.close();
      await proxy?.stop();
      if (catalogDb && original) {
        await catalogDb.query('DELETE FROM catalog.stock_reservation_lines');
        await catalogDb.query('DELETE FROM catalog.stock_reservations');
        for (const row of original) {
          await catalogDb.query(
            'UPDATE catalog.products SET price = $1, stock = $2, is_active = $3 WHERE id = $4',
            [row.price, row.stock, row.is_active, row.id],
          );
        }
      }
      await prisma?.$disconnect();
      await Promise.all([catalogDb?.end(), identityDb?.end()]);
    });

    it('CA-M04-01 and CA-M04-04: approved payment creates one PAGADO order with frozen server prices, deducts stock and empties the cart', async () => {
      await addToCart(ana, MOUSE, 2);
      await addToCart(ana, CAMERA, 1);
      const before = await summary(ana);
      expect(before).toMatchObject({ total: '389.95', checkoutAllowed: true, itemCount: 3 });

      const created = await place(ana, before.fingerprint);
      expect(created.status).toBe(201);
      const confirmation = parse<OrderConfirmation>(created);
      expect(confirmation).toMatchObject({
        status: 'PAGADO',
        total: '389.95',
        currency: 'GTQ',
        itemCount: 3,
      });
      expect(confirmation.orderNumber).toMatch(/^SP-\d{5,}$/);
      expect(confirmation.paymentReference).toMatch(/^SIM-[0-9A-F]{16}$/);
      expect(confirmation.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ productId: MOUSE, unitPrice: '150.00', lineTotal: '300.00' }),
          expect.objectContaining({ productId: CAMERA, unitPrice: '89.95', lineTotal: '89.95' }),
        ]),
      );

      expect(await prisma.order.count({ where: { userId: ana.userId } })).toBe(1);
      expect(await stock(MOUSE)).toBe(3);
      expect(await stock(CAMERA)).toBe(5);
      const attempt = await attemptFor(ana.userId);
      expect(attempt).toMatchObject({ state: 'COMPLETED', orderId: confirmation.id });
      expect(attempt.shipping).toBeNull();
      // DT-08: tras C3, Commerce reconoce la reserva con su pedido (CONFIRMED → FULFILLED).
      expect(await reservation(attempt.reservationId)).toBe('FULFILLED');
      expect(attempt.inventoryFulfilledAt).toBeInstanceOf(Date);
      expect(
        await prisma.cart.findFirstOrThrow({ where: { userId: ana.userId, status: 'CONVERTIDO' } }),
      ).toBeTruthy();
      const cart = await supertest(server).get('/cart').set('Cookie', ana.cookieHeader());
      expect(parse<ShoppingCart>(cart)).toMatchObject({ itemCount: 0, status: 'ACTIVO' });

      // El precio del pedido queda congelado aunque Catalog cambie después (CA-M05-03).
      await catalogDb.query('UPDATE catalog.products SET price = $1 WHERE id = $2', [
        '999.00',
        MOUSE,
      ]);
      const detail = await supertest(server)
        .get(`/orders/${confirmation.id}`)
        .set('Cookie', ana.cookieHeader());
      expect(detail.status).toBe(200);
      expect(parse<OrderConfirmation>(detail).items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ productId: MOUSE, unitPrice: '150.00' }),
        ]),
      );
      const events = await prisma.outboxEvent.findMany({ where: { eventType: 'ORDER_CREATED' } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        result: 'EXITO',
        actorId: ana.userId,
        resourceId: confirmation.id,
      });
    });

    it('CA-M04-04/PT07 and CA-M04-05: monetary, ownership and card fields are rejected without side effects; the schema has no card columns', async () => {
      await addToCart(ana, MOUSE, 1);
      const { fingerprint } = await summary(ana);
      const csrf = await ana.csrf();
      const valid = {
        ...SHIPPING,
        simulatedPaymentResult: 'APROBADO',
        cartFingerprint: fingerprint,
      };
      for (const extra of [
        { total: '0.01' },
        { items: [{ productId: MOUSE, price: '0.01' }] },
        { price: '0.01' },
        { userId: bruno.userId },
        { cardNumber: '4111111111111111' },
        { cvv: '123' },
        { expiry: '12/30' },
        { status: 'ENTREGADO' },
      ]) {
        const response = await order(ana, csrf, randomUUID(), { ...valid, ...extra });
        expect(response.status).toBe(400);
        expect(parse<ApiErrorResponse>(response).code).toBe('VALIDATION_ERROR');
      }
      expect(await prisma.checkoutAttempt.count()).toBe(0);
      expect(await stock(MOUSE)).toBe(5);

      const columns = await prisma.$queryRaw<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'commerce'
           AND column_name ~* '(card|tarjeta|cvv|cvc|vencimiento|expiry|exp_month|exp_year|pan)'`;
      expect(columns).toEqual([]);
    });

    it('CA-M04-02: a rejected simulated payment leaves stock, cart and orders untouched and is audited', async () => {
      await addToCart(ana, MOUSE, 2);
      const { fingerprint } = await summary(ana);
      const key = randomUUID();
      const rejected = await place(ana, fingerprint, 'RECHAZADO', key);
      expect(rejected.status).toBe(422);
      expect(parse<ApiErrorResponse>(rejected)).toMatchObject({
        code: 'PAYMENT_SIMULATED_REJECTED',
        message: 'El pago simulado fue rechazado',
      });
      expect(await prisma.order.count()).toBe(0);
      expect(await stock(MOUSE)).toBe(5);
      const attempt = await attemptFor(ana.userId);
      expect(attempt.state).toBe('REJECTED');
      expect(await reservation(attempt.reservationId)).toBeUndefined();
      const cart = await prisma.cart.findFirstOrThrow({
        where: { userId: ana.userId, status: 'ACTIVO' },
        include: { items: true },
      });
      expect(cart.items).toEqual([expect.objectContaining({ productId: MOUSE, quantity: 2 })]);
      expect(
        await prisma.outboxEvent.count({ where: { eventType: 'PAYMENT_SIMULATED_REJECTED' } }),
      ).toBe(1);

      const replay = await place(ana, fingerprint, 'RECHAZADO', key);
      expect(replay.status).toBe(422);
      expect(
        await prisma.outboxEvent.count({ where: { eventType: 'PAYMENT_SIMULATED_REJECTED' } }),
      ).toBe(1);

      // Flujo del mockup: tras rechazar, un nuevo intento aprobado compra el carrito intacto.
      const approved = await place(ana, fingerprint, 'APROBADO');
      expect(approved.status).toBe(201);
      expect(await stock(MOUSE)).toBe(3);
    });

    it('CA-M04-03/PT14: five concurrent submissions with the same key create exactly one order', async () => {
      await addToCart(ana, MOUSE, 1);
      const { fingerprint } = await summary(ana);
      const key = randomUUID();
      const csrf = await ana.csrf();
      const body = {
        ...SHIPPING,
        simulatedPaymentResult: 'APROBADO',
        cartFingerprint: fingerprint,
      };
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => order(ana, csrf, key, body)),
      );
      const statuses = responses.map((response) => response.status).sort();
      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      expect(statuses.every((status) => status === 200 || status === 201)).toBe(true);
      const ids = new Set(responses.map((response) => parse<OrderConfirmation>(response).id));
      expect(ids.size).toBe(1);
      expect(await prisma.order.count()).toBe(1);
      expect(await stock(MOUSE)).toBe(4);

      const replay = await order(ana, csrf, key, body);
      expect(replay.status).toBe(200);
      expect(parse<OrderConfirmation>(replay).id).toBe([...ids][0]);

      const reused = await order(ana, csrf, key, { ...body, address: 'Otra dirección ficticia 9' });
      expect(reused.status).toBe(422);
      expect(parse<ApiErrorResponse>(reused).code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await prisma.order.count()).toBe(1);
    });

    it('two different keys racing on the same cart produce a single order', async () => {
      await addToCart(ana, MOUSE, 2);
      const { fingerprint } = await summary(ana);
      const csrf = await ana.csrf();
      const body = {
        ...SHIPPING,
        simulatedPaymentResult: 'APROBADO',
        cartFingerprint: fingerprint,
      };
      const responses = await Promise.all([
        order(ana, csrf, randomUUID(), body),
        order(ana, csrf, randomUUID(), body),
      ]);
      const statuses = responses.map((response) => response.status).sort();
      expect(statuses[0]).toBe(201);
      expect(statuses[1]).toBe(409);
      const conflict = responses.find((response) => response.status === 409)!;
      expect(['CHECKOUT_IN_PROGRESS', 'CHECKOUT_CART_EMPTY']).toContain(
        parse<ApiErrorResponse>(conflict).code,
      );
      expect(await prisma.order.count()).toBe(1);
      expect(await stock(MOUSE)).toBe(3);
    });

    it('CA-M04-06: stock lowered after the summary returns 409 with the affected lines and no order', async () => {
      await addToCart(ana, STAND, 3);
      await addToCart(ana, CAMERA, 1);
      const { fingerprint } = await summary(ana);
      await catalogDb.query('UPDATE catalog.products SET stock = 2 WHERE id = $1', [STAND]);
      const response = await place(ana, fingerprint);
      expect(response.status).toBe(409);
      const body = parse<ApiErrorResponse>(response);
      expect(body.code).toBe('CHECKOUT_STOCK_CONFLICT');
      expect(body.details?.conflicts).toEqual([
        { productId: STAND, reason: 'INSUFFICIENT_STOCK', available: 2 },
      ]);
      expect(await prisma.order.count()).toBe(0);
      expect(await stock(STAND)).toBe(2);
      expect(await stock(CAMERA)).toBe(6);
      expect((await attemptFor(ana.userId)).state).toBe('FAILED');
      expect(
        await prisma.outboxEvent.count({ where: { eventType: 'CHECKOUT_STOCK_CONFLICT' } }),
      ).toBe(1);
      const cart = await prisma.cart.findFirstOrThrow({
        where: { userId: ana.userId, status: 'ACTIVO' },
        include: { items: true },
      });
      expect(cart.items).toHaveLength(2);
    });

    it('ERS A4: a price change after the summary requires a new confirmation with the new total', async () => {
      await addToCart(ana, MOUSE, 2);
      const first = await summary(ana);
      await catalogDb.query('UPDATE catalog.products SET price = $1 WHERE id = $2', [
        '175.25',
        MOUSE,
      ]);
      const changed = await place(ana, first.fingerprint);
      expect(changed.status).toBe(409);
      expect(parse<ApiErrorResponse>(changed).code).toBe('CHECKOUT_SUMMARY_CHANGED');
      expect(await stock(MOUSE)).toBe(5);
      expect(await catalogDb.query('SELECT 1 FROM catalog.stock_reservations')).toMatchObject({
        rowCount: 0,
      });

      const second = await summary(ana);
      expect(second.total).toBe('350.50');
      expect(second.fingerprint).not.toBe(first.fingerprint);
      const created = await place(ana, second.fingerprint);
      expect(created.status).toBe(201);
      expect(parse<OrderConfirmation>(created).total).toBe('350.50');
    });

    it('a price change between validation and reservation is caught atomically by Catalog', async () => {
      await addToCart(ana, MOUSE, 1);
      const { fingerprint } = await summary(ana);
      proxy.on(RESERVE, {
        kind: 'before',
        action: async () => {
          await catalogDb.query('UPDATE catalog.products SET price = $1 WHERE id = $2', [
            '151.00',
            MOUSE,
          ]);
        },
      });
      const response = await place(ana, fingerprint);
      expect(response.status).toBe(409);
      expect(parse<ApiErrorResponse>(response).code).toBe('CHECKOUT_SUMMARY_CHANGED');
      expect(await stock(MOUSE)).toBe(5);
      expect(await prisma.order.count()).toBe(0);
    });

    it('concurrent buyers for the last unit: exactly one order and no oversell', async () => {
      await catalogDb.query('UPDATE catalog.products SET stock = 1 WHERE id = $1', [MIC]);
      await addToCart(ana, MIC, 1);
      await addToCart(bruno, MIC, 1);
      const [anaSummary, brunoSummary] = await Promise.all([summary(ana), summary(bruno)]);
      const responses = await Promise.all([
        place(ana, anaSummary.fingerprint),
        place(bruno, brunoSummary.fingerprint),
      ]);
      const statuses = responses.map((response) => response.status).sort();
      expect(statuses).toEqual([201, 409]);
      const loser = responses.find((response) => response.status === 409)!;
      expect(parse<ApiErrorResponse>(loser).code).toBe('CHECKOUT_STOCK_CONFLICT');
      expect(await stock(MIC)).toBe(0);
      expect(await prisma.order.count()).toBe(1);
    });

    it('RNF-REN-02: twenty concurrent buyers over five units never oversell (p95 measured)', async () => {
      const buyers = await Promise.all(
        Array.from({ length: 20 }, () =>
          SyntheticBuyer.provision(identityDb, privateKey, cookieNames),
        ),
      );
      for (const buyer of buyers) await addToCart(buyer, MIC, 1);
      const summaries = await Promise.all(buyers.map((buyer) => summary(buyer)));
      const timings: number[] = [];
      const responses = await Promise.all(
        buyers.map(async (buyer, index) => {
          const started = performance.now();
          const response = await place(buyer, summaries[index]!.fingerprint);
          timings.push(performance.now() - started);
          return response;
        }),
      );
      const created = responses.filter((response) => response.status === 201);
      const conflicts = responses.filter((response) => response.status === 409);
      expect(created).toHaveLength(5);
      expect(conflicts).toHaveLength(15);
      expect(
        conflicts.every(
          (response) => parse<ApiErrorResponse>(response).code === 'CHECKOUT_STOCK_CONFLICT',
        ),
      ).toBe(true);
      expect(await stock(MIC)).toBe(0);
      expect(await prisma.order.count()).toBe(5);
      const sorted = [...timings].sort((left, right) => left - right);
      const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
      process.stdout.write(
        `[EV-M04] 20 checkouts concurrentes: p95=${p95.toFixed(0)} ms, max=${sorted.at(-1)!.toFixed(0)} ms\n`,
      );
      expect(p95).toBeLessThan(10_000);
    });

    it('CA-M04-07: CSRF/Origin, Idempotency-Key, role and session controls reject the confirmation', async () => {
      await addToCart(ana, MOUSE, 1);
      const { fingerprint } = await summary(ana);
      const body = {
        ...SHIPPING,
        simulatedPaymentResult: 'APROBADO',
        cartFingerprint: fingerprint,
      };
      const key = randomUUID();

      const withoutToken = await supertest(server)
        .post('/orders')
        .set('Cookie', ana.cookieHeader())
        .set('Origin', ORIGIN)
        .set('Idempotency-Key', key)
        .send(body);
      expect(withoutToken.status).toBe(403);
      expect(parse<ApiErrorResponse>(withoutToken).code).toBe('CSRF_INVALID');

      const csrf = await ana.csrf();
      const foreign = await order(ana, csrf, key, body).set('Origin', 'http://localhost:9999');
      expect(foreign.status).toBe(403);
      const wrongToken = await order(ana, 'x'.repeat(csrf.length), key, body);
      expect(wrongToken.status).toBe(403);

      const missingKey = await supertest(server)
        .post('/orders')
        .set('Cookie', ana.cookieHeader())
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', csrf)
        .send(body);
      expect(missingKey.status).toBe(400);
      expect(parse<ApiErrorResponse>(missingKey).code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      const notV4 = await order(ana, csrf, '6ba7b810-9dad-11d1-80b4-00c04fd430c8', body);
      expect(notV4.status).toBe(400);

      const adminCsrf = await admin.csrf();
      const asAdmin = await order(admin, adminCsrf, randomUUID(), body);
      expect(asAdmin.status).toBe(403);
      const anonymous = await supertest(server).post('/orders').send(body);
      expect(anonymous.status).toBe(401);
      const [header, payload] = ana.cookies.get(cookieNames.access)!.split('.');
      const forged = `${header}.${payload}.`;
      const forgedResponse = await supertest(server)
        .post('/orders')
        .set('Cookie', `${cookieNames.access}=${forged}`)
        .send(body);
      expect(forgedResponse.status).toBe(401);

      expect(await prisma.checkoutAttempt.count()).toBe(0);
      expect(await stock(MOUSE)).toBe(5);
    });

    it('RF-021: invalid fictitious shipping data is rejected field by field', async () => {
      await addToCart(ana, MOUSE, 1);
      const { fingerprint } = await summary(ana);
      const csrf = await ana.csrf();
      const valid = {
        ...SHIPPING,
        simulatedPaymentResult: 'APROBADO',
        cartFingerprint: fingerprint,
      };
      for (const invalid of [
        { recipientName: 'A' },
        { recipientName: 'Ana 123' },
        { phone: '5555-010' },
        { phone: '55550101a' },
        { department: 'Narnia' },
        { municipality: 'M' },
        { address: 'Ca 1' },
        { references: '<script>alert(1)</script>' },
        { references: 'x'.repeat(201) },
        { simulatedPaymentResult: 'PENDIENTE' },
        { cartFingerprint: 'abc' },
      ]) {
        const response = await order(ana, csrf, randomUUID(), { ...valid, ...invalid });
        expect(response.status, JSON.stringify(invalid)).toBe(400);
      }
      const normalized = await order(ana, csrf, randomUUID(), {
        ...valid,
        phone: '55550101',
        references: undefined,
      });
      expect(normalized.status).toBe(201);
      expect(parse<OrderConfirmation>(normalized).shipping).toEqual({
        recipientName: SHIPPING.recipientName,
        phone: '5555-0101',
        department: SHIPPING.department,
        municipality: SHIPPING.municipality,
        address: SHIPPING.address,
      });
    });

    it('IDOR: another customer receives a uniform 404 for a foreign order and ACCESS_DENIED is recorded', async () => {
      await addToCart(ana, MOUSE, 1);
      const created = await place(ana, (await summary(ana)).fingerprint);
      const { id } = parse<OrderConfirmation>(created);
      const foreign = await supertest(server)
        .get(`/orders/${id}`)
        .set('Cookie', bruno.cookieHeader());
      const missing = await supertest(server)
        .get(`/orders/${randomUUID()}`)
        .set('Cookie', bruno.cookieHeader());
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      const foreignBody = parse<ApiErrorResponse>(foreign);
      const missingBody = parse<ApiErrorResponse>(missing);
      expect(foreignBody).toMatchObject({
        code: 'ORDER_NOT_FOUND',
        message: 'Pedido no encontrado',
      });
      expect({ code: missingBody.code, message: missingBody.message }).toEqual({
        code: foreignBody.code,
        message: foreignBody.message,
      });
      const denied = await prisma.outboxEvent.findMany({ where: { eventType: 'ACCESS_DENIED' } });
      expect(denied).toHaveLength(1);
      expect(denied[0]).toMatchObject({
        actorId: bruno.userId,
        resourceId: id,
        result: 'DENEGADO',
      });
      const invalidId = await supertest(server)
        .get('/orders/123')
        .set('Cookie', bruno.cookieHeader());
      expect(invalidId.status).toBe(400);
    });

    it('Catalog down before the reservation aborts without business effects; the same key then succeeds', async () => {
      await addToCart(ana, MOUSE, 1);
      const { fingerprint } = await summary(ana);
      const key = randomUUID();
      config.catalogUrl = new URL('http://127.0.0.1:9');
      const down = await place(ana, fingerprint, 'APROBADO', key);
      expect(down.status).toBe(503);
      expect(parse<ApiErrorResponse>(down).code).toBe('CATALOG_UNAVAILABLE');
      expect((await attemptFor(ana.userId)).state).toBe('ABORTED');
      expect(await stock(MOUSE)).toBe(5);

      config.catalogUrl = proxyUrl;
      const retried = await place(ana, fingerprint, 'APROBADO', key);
      expect(retried.status).toBe(201);
      expect(await stock(MOUSE)).toBe(4);
      expect(await prisma.order.count()).toBe(1);
    });

    it('lost reservation response (applied in Catalog) is compensated immediately; the same key then succeeds', async () => {
      await addToCart(ana, MOUSE, 2);
      const { fingerprint } = await summary(ana);
      const key = randomUUID();
      proxy.on(RESERVE, { kind: 'fail-after' });
      const pending = await place(ana, fingerprint, 'APROBADO', key);
      expect(pending.status).toBe(503);
      expect(parse<ApiErrorResponse>(pending).code).toBe('CHECKOUT_PENDING');
      const attempt = await attemptFor(ana.userId);
      expect(attempt).toMatchObject({ state: 'ABORTED', failureCode: 'CATALOG_UNAVAILABLE' });
      expect(await reservation(attempt.reservationId)).toBe('RELEASED');
      expect(await stock(MOUSE)).toBe(5);

      proxy.reset();
      const retried = await place(ana, fingerprint, 'APROBADO', key);
      expect(retried.status).toBe(201);
      expect(await stock(MOUSE)).toBe(3);
      expect(await prisma.order.count()).toBe(1);
    });

    it('Catalog down at confirmation leaves a pending saga that the recovery worker compensates', async () => {
      await addToCart(ana, STAND, 2);
      const { fingerprint } = await summary(ana);
      proxy.on(CONFIRM, { kind: 'fail-before' });
      const pending = await place(ana, fingerprint);
      expect(pending.status).toBe(503);
      expect(parse<ApiErrorResponse>(pending).code).toBe('CHECKOUT_PENDING');
      const attempt = await attemptFor(ana.userId);
      expect(attempt.state).toBe('RESERVED');
      expect(await reservation(attempt.reservationId)).toBe('PENDING');
      expect(await stock(STAND)).toBe(1);
      const locked = await mutate(ana, 'post', '/cart/items', { productId: CAMERA, quantity: 1 });
      expect(locked.status).toBe(409);
      expect(parse<ApiErrorResponse>(locked).code).toBe('CART_LOCKED_FOR_CHECKOUT');

      proxy.reset();
      const result = await recovery.runOnce();
      expect(result.outcomes.ABORTED).toBe(1);
      expect((await attemptFor(ana.userId)).state).toBe('ABORTED');
      expect(await reservation(attempt.reservationId)).toBe('RELEASED');
      expect(await stock(STAND)).toBe(3);
      expect(await prisma.order.count()).toBe(0);
      const unlocked = await mutate(ana, 'post', '/cart/items', { productId: CAMERA, quantity: 1 });
      expect(unlocked.status).toBe(200);
    });

    it('a same-key retry after a pending confirmation reconciles, compensates and completes exactly once', async () => {
      await addToCart(ana, STAND, 1);
      const { fingerprint } = await summary(ana);
      const key = randomUUID();
      proxy.on(CONFIRM, { kind: 'fail-before' });
      expect((await place(ana, fingerprint, 'APROBADO', key)).status).toBe(503);
      const first = await attemptFor(ana.userId);
      proxy.reset();

      const retried = await place(ana, fingerprint, 'APROBADO', key);
      expect(retried.status).toBe(201);
      const final = await attemptFor(ana.userId);
      expect(final.id).toBe(first.id);
      expect(final.state).toBe('COMPLETED');
      expect(final.reservationId).not.toBe(first.reservationId);
      expect(await reservation(first.reservationId)).toBe('RELEASED');
      expect(await reservation(final.reservationId)).toBe('FULFILLED');
      expect(await stock(STAND)).toBe(2);
      expect(await prisma.order.count()).toBe(1);
    });

    it('confirmation applied but response lost: a Commerce restart completes the order forward', async () => {
      await addToCart(ana, CAMERA, 2);
      const { fingerprint } = await summary(ana);
      const key = randomUUID();
      proxy.on(CONFIRM, { kind: 'fail-after' });
      const pending = await place(ana, fingerprint, 'APROBADO', key);
      expect(pending.status).toBe(503);
      const attempt = await attemptFor(ana.userId);
      expect(attempt.state).toBe('RESERVED');
      expect(await reservation(attempt.reservationId)).toBe('CONFIRMED');
      expect(await prisma.order.count()).toBe(0);
      proxy.reset();

      // Reinicio real del proceso Commerce: el reconciliador corre en el arranque (D-M04-06).
      await app.close();
      await boot();
      const completed = await waitFor(async () => {
        const current = await prisma.checkoutAttempt.findUniqueOrThrow({
          where: { id: attempt.id },
        });
        return current.state === 'COMPLETED' ? current : undefined;
      });
      expect(completed.orderId).toBeTruthy();
      expect(await prisma.order.count()).toBe(1);
      expect(await stock(CAMERA)).toBe(4);

      const replay = await place(ana, fingerprint, 'APROBADO', key);
      expect(replay.status).toBe(200);
      expect(parse<OrderConfirmation>(replay).id).toBe(completed.orderId);
      expect(await prisma.outboxEvent.count({ where: { eventType: 'ORDER_CREATED' } })).toBe(1);
    });

    it('a reservation that expires before confirmation is released by Catalog and the saga aborts safely', async () => {
      await addToCart(ana, MOUSE, 3);
      const { fingerprint } = await summary(ana);
      const key = randomUUID();
      proxy.on(CONFIRM, {
        kind: 'before',
        action: async () => {
          await catalogDb.query(
            `UPDATE catalog.stock_reservations SET expires_at = now() - interval '1 second'
              WHERE status = 'PENDING'`,
          );
        },
      });
      const expired = await place(ana, fingerprint, 'APROBADO', key);
      expect(expired.status).toBe(409);
      expect(parse<ApiErrorResponse>(expired).code).toBe('CHECKOUT_EXPIRED');
      const attempt = await attemptFor(ana.userId);
      expect(attempt).toMatchObject({ state: 'ABORTED', failureCode: 'RESERVATION_EXPIRED' });
      expect(await reservation(attempt.reservationId)).toBe('RELEASED');
      expect(await stock(MOUSE)).toBe(5);

      proxy.reset();
      expect((await place(ana, fingerprint, 'APROBADO', key)).status).toBe(201);
      expect(await stock(MOUSE)).toBe(2);
    });

    it('the cart is frozen and a second key is refused while a checkout is in flight', async () => {
      await addToCart(ana, MOUSE, 1);
      const cart = parse<ShoppingCart>(
        await supertest(server).get('/cart').set('Cookie', ana.cookieHeader()),
      );
      const { fingerprint } = await summary(ana);
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      proxy.on(CONFIRM, { kind: 'hold', gate });
      const inflight = place(ana, fingerprint);
      await waitFor(async () => {
        const attempt = await prisma.checkoutAttempt.findFirst({ where: { userId: ana.userId } });
        return attempt?.state === 'RESERVED' ? attempt : undefined;
      });

      const update = await mutate(ana, 'patch', `/cart/items/${cart.items[0]!.id}`, {
        quantity: 2,
      });
      expect(update.status).toBe(409);
      expect(parse<ApiErrorResponse>(update).code).toBe('CART_LOCKED_FOR_CHECKOUT');
      const during = await summary(ana);
      expect(during).toMatchObject({ checkoutInProgress: true, checkoutAllowed: false });
      const second = await place(ana, fingerprint);
      expect(second.status).toBe(409);
      expect(parse<ApiErrorResponse>(second).code).toBe('CHECKOUT_IN_PROGRESS');

      open();
      expect((await inflight).status).toBe(201);
      expect(await prisma.order.count()).toBe(1);
    });

    it('RS10: the per-account attempt limit answers 429', async () => {
      config.checkoutAttemptsPerMinute = 2;
      try {
        await addToCart(ana, MOUSE, 1);
        const { fingerprint } = await summary(ana);
        expect((await place(ana, fingerprint, 'RECHAZADO')).status).toBe(422);
        expect((await place(ana, fingerprint, 'RECHAZADO')).status).toBe(422);
        const limited = await place(ana, fingerprint, 'RECHAZADO');
        expect(limited.status).toBe(429);
        expect(parse<ApiErrorResponse>(limited).code).toBe('CHECKOUT_RATE_LIMITED');
      } finally {
        config.checkoutAttemptsPerMinute = 1_000;
      }
    });

    it('RN-17: an idempotency key is valid for 24 hours only', async () => {
      await addToCart(ana, MOUSE, 1);
      const { fingerprint } = await summary(ana);
      const key = randomUUID();
      expect((await place(ana, fingerprint, 'APROBADO', key)).status).toBe(201);
      await prisma.checkoutAttempt.updateMany({
        where: { idempotencyKey: key },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const expired = await place(ana, fingerprint, 'APROBADO', key);
      expect(expired.status).toBe(422);
      expect(parse<ApiErrorResponse>(expired).code).toBe('IDEMPOTENCY_KEY_EXPIRED');
      expect(await prisma.order.count()).toBe(1);
    });

    it('the internal inventory API is not published and requires the inventory-scoped token', async () => {
      const internal = new URL(process.env.CATALOG_INTERNAL_URL!);
      const reserveUrl = new URL('/internal/catalog/stock-reservations', internal);
      const body = JSON.stringify({
        reservationId: randomUUID(),
        lines: [{ productId: MOUSE, quantity: 1, expectedUnitPrice: '150.00' }],
      });
      const headers = { 'Content-Type': 'application/json' };
      const anonymous = await fetch(reserveUrl, { method: 'POST', headers, body });
      expect(anonymous.status).toBe(503);
      const sharedToken = await fetch(reserveUrl, {
        method: 'POST',
        headers: { ...headers, 'X-Spectra-Internal-Token': config.internalToken },
        body,
      });
      expect(sharedToken.status).toBe(503);
      expect(await stock(MOUSE)).toBe(5);
      const scoped = await fetch(
        new URL(`/internal/catalog/stock-reservations/${randomUUID()}`, internal),
        {
          headers: { 'X-Spectra-Internal-Token': config.inventoryToken },
        },
      );
      expect(scoped.status).toBe(200);
      const published = await fetch(
        `http://catalog-service:3002/internal/catalog/stock-reservations/${randomUUID()}`,
      );
      expect(published.status).toBe(404);
    });

    it('PT16/RN-30: outbox events keep whitelisted metadata only, without delivery data or tokens', async () => {
      await addToCart(ana, MOUSE, 1);
      const { fingerprint } = await summary(ana);
      await place(ana, fingerprint, 'RECHAZADO');
      await place(ana, fingerprint, 'APROBADO');
      const events = await prisma.outboxEvent.findMany();
      expect(events.map((event) => event.eventType).sort()).toEqual([
        'ORDER_CREATED',
        'PAYMENT_SIMULATED_REJECTED',
      ]);
      const serialized = JSON.stringify(events);
      for (const forbidden of [
        SHIPPING.recipientName,
        SHIPPING.phone,
        SHIPPING.address,
        SHIPPING.references,
        SHIPPING.municipality,
        ana.cookies.get(cookieNames.access)!,
        ana.email,
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
      for (const event of events) {
        expect(event).toMatchObject({ actorId: ana.userId, actorRole: 'CLIENTE' });
        expect(event.requestId).toMatch(/^[0-9a-f-]{36}$/);
      }
    });
  },
);
