import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type {
  ApiErrorResponse,
  CheckoutSummary,
  OrderConfirmation,
  OrderDetail,
  OrderHistoryPage,
} from '@spectra/contracts';
import cookieParser from 'cookie-parser';
import { Pool } from 'pg';
import supertest, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Buyer, ORIGIN, SyntheticBuyer } from '../test-support/identity-agents.js';
import { seedOrder, simulateAdminTransition } from '../test-support/order-fixtures.js';

// Producto del seed M01 usado para la compra real M04 → M05; se restaura al final.
const MIC = '20000000-0000-4000-8000-000000000008';
const MIC_BASELINE = { price: '499.99', stock: 5 };

const SHIPPING = {
  recipientName: 'Ana Pérez Sintética',
  phone: '5555-0101',
  department: 'Guatemala',
  municipality: 'Mixco',
  address: 'Calle ficticia 1-23, zona 1',
  references: 'Portón azul ficticio',
};

const ERROR_KEYS = ['code', 'message', 'requestId', 'statusCode', 'timestamp'];

function parse<T>(response: Response): T {
  return JSON.parse(response.text) as T;
}

function minutesAfter(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

describe.skipIf(!process.env.COMMERCE_DATABASE_URL)(
  'M05 order management with real Identity, Catalog (HTTP) and PostgreSQL',
  () => {
    let app: INestApplication;
    let server: Server;
    // DT-09: cliente de fixtures separado (rol migrador); la aplicación usa el rol de ejecución.
    let prisma: import('../generated/commerce-client/index.js').PrismaClient;
    let config: typeof import('../config/commerce.config.js').commerceConfig;
    let catalogDb: Pool;
    let identityDb: Pool;
    let privateKey: string;
    let cookieNames: { access: string; csrf: string };
    let micOriginal: { price: string; stock: number; name: string; is_active: boolean };
    let ana: SyntheticBuyer;
    let bruno: SyntheticBuyer;
    let carla: SyntheticBuyer;
    let admin: SyntheticBuyer;

    function buyer(role: 'CLIENTE' | 'ADMIN' = 'CLIENTE'): Promise<SyntheticBuyer> {
      return SyntheticBuyer.provision(identityDb, privateKey, cookieNames, role);
    }

    function get(who: Buyer | undefined, path: string): supertest.Test {
      const request = supertest(server).get(path);
      return who ? request.set('Cookie', who.cookieHeader()) : request;
    }

    async function history(who: Buyer, page?: number): Promise<OrderHistoryPage> {
      const response = await get(who, page === undefined ? '/orders' : `/orders?page=${page}`);
      expect(response.status).toBe(200);
      return parse<OrderHistoryPage>(response);
    }

    async function detail(who: Buyer, orderId: string): Promise<OrderDetail> {
      const response = await get(who, `/orders/${orderId}`);
      expect(response.status).toBe(200);
      return parse<OrderDetail>(response);
    }

    async function mutate(
      who: Buyer,
      method: 'post' | 'patch' | 'put' | 'delete',
      path: string,
      body: Record<string, unknown> = {},
      headers: Record<string, string> = {},
    ): Promise<Response> {
      let request = supertest(server)
        [method](path)
        .set('Cookie', who.cookieHeader())
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', await who.csrf())
        .set('Content-Type', 'application/json');
      for (const [name, value] of Object.entries(headers)) request = request.set(name, value);
      return request.send(body);
    }

    /** Compra real M04 (Commerce → Catalog por HTTP) que alimenta el historial M05. */
    async function purchase(
      who: Buyer,
      productId: string,
      quantity: number,
    ): Promise<OrderConfirmation> {
      const added = await mutate(who, 'post', '/cart/items', { productId, quantity });
      expect(added.status).toBe(200);
      const summary = parse<CheckoutSummary>(await get(who, '/checkout/summary').expect(200));
      const placed = await mutate(
        who,
        'post',
        '/orders',
        { ...SHIPPING, simulatedPaymentResult: 'APROBADO', cartFingerprint: summary.fingerprint },
        { 'Idempotency-Key': randomUUID() },
      );
      expect(placed.status).toBe(201);
      return parse<OrderConfirmation>(placed);
    }

    beforeAll(async () => {
      catalogDb = new Pool({ connectionString: process.env.CATALOG_TEST_DATABASE_URL });
      identityDb = new Pool({ connectionString: process.env.IDENTITY_TEST_DATABASE_URL });
      privateKey = await readFile(process.env.IDENTITY_TEST_PRIVATE_KEY_PATH!, 'utf8');
      micOriginal = (
        await catalogDb.query<{ price: string; stock: number; name: string; is_active: boolean }>(
          'SELECT price::text AS price, stock, name, is_active FROM catalog.products WHERE id = $1',
          [MIC],
        )
      ).rows[0]!;

      const configModule = await import('../config/commerce.config.js');
      config = configModule.commerceConfig;
      config.recoveryIntervalMs = 0;
      cookieNames = {
        access: configModule.accessCookieName(),
        csrf: configModule.csrfCookieName(),
      };
      const [{ AppModule }, fixtureModule] = await Promise.all([
        import('../app.module.js'),
        import('../test-support/fixture-client.js'),
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
      [ana, bruno, carla, admin] = await Promise.all([buyer(), buyer(), buyer(), buyer('ADMIN')]);
    });

    beforeEach(async () => {
      await prisma.orderItem.deleteMany();
      await prisma.order.deleteMany();
      await prisma.checkoutAttempt.deleteMany();
      await prisma.outboxEvent.deleteMany();
      await prisma.cartItem.deleteMany();
      await prisma.cart.deleteMany();
      await catalogDb.query(
        'UPDATE catalog.products SET price = $1, stock = $2, name = $3, is_active = true WHERE id = $4',
        [MIC_BASELINE.price, MIC_BASELINE.stock, micOriginal.name, MIC],
      );
    });

    afterAll(async () => {
      if (app) await app.close();
      if (catalogDb && micOriginal) {
        await catalogDb.query(
          'UPDATE catalog.products SET price = $1, stock = $2, name = $3, is_active = $4 WHERE id = $5',
          [micOriginal.price, micOriginal.stock, micOriginal.name, micOriginal.is_active, MIC],
        );
      }
      await prisma?.$disconnect();
      await Promise.all([catalogDb?.end(), identityDb?.end()]);
    });

    it('CA-M05-01/RF-026: each customer only sees their own orders, newest first, without delivery data', async () => {
      const base = new Date('2026-11-10T10:00:00.000Z');
      const anaOrders = [];
      for (let index = 0; index < 3; index += 1) {
        anaOrders.push(
          await seedOrder(prisma, ana.userId, { createdAt: minutesAfter(base, index) }),
        );
      }
      const brunoOrders = [
        await seedOrder(prisma, bruno.userId, { createdAt: minutesAfter(base, 10) }),
        await seedOrder(prisma, bruno.userId, { createdAt: minutesAfter(base, 11) }),
      ];

      const anaPage = await history(ana);
      expect(anaPage.meta).toEqual({ page: 1, pageSize: 10, totalItems: 3, totalPages: 1 });
      expect(anaPage.items.map((order) => order.id)).toEqual(
        [...anaOrders].reverse().map((order) => order.id),
      );
      expect(anaPage.items.map((order) => order.id)).not.toEqual(
        expect.arrayContaining(brunoOrders.map((order) => order.id)),
      );
      expect(anaPage.items[0]).toEqual({
        id: anaOrders[2]!.id,
        orderNumber: anaOrders[2]!.orderNumber,
        status: 'PAGADO',
        statusChangedAt: minutesAfter(base, 2).toISOString(),
        createdAt: minutesAfter(base, 2).toISOString(),
        itemCount: 1,
        total: '150.00',
        currency: 'GTQ',
      });
      // Minimización: el historial no expone entrega, referencia de pago ni propietario.
      for (const field of ['shipping', 'paymentReference', 'userId', 'items']) {
        expect(anaPage.items[0]).not.toHaveProperty(field);
      }

      const brunoPage = await history(bruno);
      expect(brunoPage.items.map((order) => order.id)).toEqual(
        [...brunoOrders].reverse().map((order) => order.id),
      );

      // A1: un cliente sin pedidos recibe una página vacía (estado vacío en P07).
      expect(await history(carla)).toEqual({
        items: [],
        meta: { page: 1, pageSize: 10, totalItems: 0, totalPages: 0 },
      });
    });

    it('D-M05-04: pagination is fixed at 10 by the server, stable on ties and never mixes owners', async () => {
      const base = new Date('2026-11-01T08:00:00.000Z');
      const seeded = [];
      for (let index = 0; index < 23; index += 1) {
        // Cada tres pedidos comparten createdAt: el desempate por id debe ser estable.
        seeded.push(
          await seedOrder(prisma, ana.userId, {
            createdAt: minutesAfter(base, Math.floor(index / 3)),
          }),
        );
      }
      await seedOrder(prisma, bruno.userId, { createdAt: minutesAfter(base, 100) });

      const pages = [await history(ana, 1), await history(ana, 2), await history(ana, 3)];
      expect(pages.map((page) => page.items.length)).toEqual([10, 10, 3]);
      for (const page of pages) {
        expect(page.meta).toMatchObject({ pageSize: 10, totalItems: 23, totalPages: 3 });
      }
      const ids = pages.flatMap((page) => page.items.map((order) => order.id));
      expect(new Set(ids).size).toBe(23);
      expect(new Set(ids)).toEqual(new Set(seeded.map((order) => order.id)));
      const dates = pages.flatMap((page) => page.items.map((order) => order.createdAt));
      expect(dates).toEqual([...dates].sort().reverse());
      expect((await history(ana, 1)).items.map((order) => order.id)).toEqual(
        pages[0]!.items.map((order) => order.id),
      );

      const beyond = await history(ana, 4);
      expect(beyond).toEqual({
        items: [],
        meta: { page: 4, pageSize: 10, totalItems: 23, totalPages: 3 },
      });

      // El cliente no controla el tamaño ni el propietario; parámetros inválidos → 400 genérico.
      for (const query of [
        'page=0',
        'page=-1',
        'page=1.5',
        'page=abc',
        'page=10001',
        "page=1'%20OR%20'1'='1",
        'pageSize=100',
        'limit=100',
        'size=100',
        'take=100',
        `userId=${bruno.userId}`,
        'sort=createdAt',
      ]) {
        const response = await get(ana, `/orders?${query}`);
        expect(response.status, query).toBe(400);
        expect(Object.keys(parse<ApiErrorResponse>(response)).sort(), query).toEqual(ERROR_KEYS);
      }
    });

    it('CA-M05-03/RF-027 and M04 compatibility: a real checkout keeps frozen price and name after Catalog changes', async () => {
      const confirmed = await purchase(ana, MIC, 2);
      const orderId = confirmed.id;
      const before = await detail(ana, orderId);
      await catalogDb.query('UPDATE catalog.products SET price = $1, name = $2 WHERE id = $3', [
        '999.00',
        'Micrófono renombrado',
        MIC,
      ]);

      const after = await detail(ana, orderId);
      expect(after).toEqual(before);
      expect(after.items).toEqual([
        {
          productId: MIC,
          name: micOriginal.name,
          quantity: 2,
          unitPrice: '499.99',
          lineTotal: '999.98',
        },
      ]);
      expect(after.total).toBe('999.98');
      expect(after.shipping).toEqual(SHIPPING);
      expect(after.paymentReference).toMatch(/^SIM-[0-9A-F]+$/);
      // La orden de M04 (todas las columnas nuevas en NULL) se presenta con un único hito PAGADO.
      const row = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(after.status).toBe('PAGADO');
      expect(after.statusChangedAt).toBe(row.paidAt.toISOString());
      expect(after.timeline).toEqual([{ status: 'PAGADO', at: row.paidAt.toISOString() }]);

      const listed = await history(ana);
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0]).toMatchObject({ id: orderId, total: '999.98', itemCount: 2 });

      // La confirmación M04 (P06) sigue leyéndose por la misma ruta y conserva su contrato.
      expect(after).toEqual({
        ...confirmed,
        statusChangedAt: after.statusChangedAt,
        timeline: after.timeline,
      });
    });

    it('CA-M05-04/RF-028: status and date follow the last change recorded by the administrator (simulated, D-M05-02)', async () => {
      const paidAt = new Date('2026-11-12T09:00:00.000Z');
      const { id } = await seedOrder(prisma, ana.userId, { createdAt: paidAt });
      const steps = [
        ['EN_PREPARACION', minutesAfter(paidAt, 30)],
        ['ENVIADO', minutesAfter(paidAt, 24 * 60)],
        ['ENTREGADO', minutesAfter(paidAt, 3 * 24 * 60)],
      ] as const;
      const expectedTimeline = [{ status: 'PAGADO', at: paidAt.toISOString() }];
      for (const [status, at] of steps) {
        await simulateAdminTransition(prisma, id, status, at);
        expectedTimeline.push({ status, at: at.toISOString() });
        const current = await detail(ana, id);
        expect(current.status).toBe(status);
        expect(current.statusChangedAt).toBe(at.toISOString());
        expect(current.timeline).toEqual(expectedTimeline);
        const [listed] = (await history(ana)).items;
        expect(listed).toMatchObject({ id, status, statusChangedAt: at.toISOString() });
      }

      const cancelled = await seedOrder(prisma, ana.userId, { createdAt: paidAt });
      await simulateAdminTransition(
        prisma,
        cancelled.id,
        'EN_PREPARACION',
        minutesAfter(paidAt, 5),
      );
      await simulateAdminTransition(prisma, cancelled.id, 'CANCELADO', minutesAfter(paidAt, 9));
      const view = await detail(ana, cancelled.id);
      expect(view.status).toBe('CANCELADO');
      expect(view.statusChangedAt).toBe(minutesAfter(paidAt, 9).toISOString());
      expect(view.timeline.map((entry) => entry.status)).toEqual([
        'PAGADO',
        'EN_PREPARACION',
        'CANCELADO',
      ]);
    });

    it('the database refuses a status without its date, out-of-order dates and RN-24 violations', async () => {
      const paidAt = new Date('2026-11-12T09:00:00.000Z');
      const { id } = await seedOrder(prisma, ana.userId, { createdAt: paidAt });
      const violations = [
        { status: 'ENVIADO' as const },
        { status: 'EN_PREPARACION' as const, preparingAt: minutesAfter(paidAt, -1) },
        { status: 'PAGADO' as const, shippedAt: minutesAfter(paidAt, 1) },
        {
          status: 'CANCELADO' as const,
          preparingAt: minutesAfter(paidAt, 1),
          shippedAt: minutesAfter(paidAt, 2),
          cancelledAt: minutesAfter(paidAt, 3),
        },
        {
          status: 'ENTREGADO' as const,
          preparingAt: minutesAfter(paidAt, 3),
          shippedAt: minutesAfter(paidAt, 2),
          deliveredAt: minutesAfter(paidAt, 4),
        },
      ];
      for (const data of violations) {
        await expect(
          prisma.order.update({ where: { id }, data }),
          JSON.stringify(data),
        ).rejects.toThrow(/orders_timeline_(status|chronology)_check/);
      }
      const unchanged = await detail(ana, id);
      expect(unchanged.status).toBe('PAGADO');
      expect(unchanged.timeline).toHaveLength(1);
    });

    it('CA-M05-02/RF-029/PT03: foreign and unknown orders get the same 404 and only the foreign one records ACCESS_DENIED', async () => {
      const anaOrder = await seedOrder(prisma, ana.userId);
      const requestId = randomUUID();
      const foreign = await get(bruno, `/orders/${anaOrder.id}`).set('X-Request-Id', requestId);
      const missing = await get(bruno, `/orders/${randomUUID()}`);
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      const foreignBody = parse<ApiErrorResponse>(foreign);
      const missingBody = parse<ApiErrorResponse>(missing);
      expect(Object.keys(foreignBody).sort()).toEqual(ERROR_KEYS);
      expect(foreignBody).toMatchObject({
        statusCode: 404,
        code: 'ORDER_NOT_FOUND',
        message: 'Pedido no encontrado',
        requestId,
      });
      expect({ ...missingBody, requestId: '', timestamp: '' }).toEqual({
        ...foreignBody,
        requestId: '',
        timestamp: '',
      });
      // Ni el número SP-…, ni el propietario, ni datos del pedido se filtran en la respuesta.
      expect(foreign.text).not.toContain(anaOrder.orderNumber);
      expect(foreign.text).not.toContain(ana.userId);

      const denied = await prisma.outboxEvent.findMany({ where: { eventType: 'ACCESS_DENIED' } });
      expect(denied).toHaveLength(1);
      const [event] = denied;
      // PT17 / RN-29: fecha, tipo, actor, rol, IP, recurso, resultado y correlación.
      expect(event).toMatchObject({
        eventType: 'ACCESS_DENIED',
        result: 'DENEGADO',
        actorId: bruno.userId,
        actorRole: 'CLIENTE',
        resourceType: 'order',
        resourceId: anaOrder.id,
        requestId,
        publishedAt: null,
      });
      expect(event!.sourceIp).toEqual(expect.any(String));
      expect(event!.occurredAt).toBeInstanceOf(Date);
      // RS07: metadatos en lista blanca, sin tokens, cookies, entrega ni datos del propietario.
      expect(event!.metadata).toEqual({ operation: 'GET /orders/:id' });
      const serialized = JSON.stringify(event);
      for (const secret of [bruno.cookieHeader(), ana.userId, 'Calle ficticia', 'SIM-']) {
        expect(serialized).not.toContain(secret);
      }

      // Su propio pedido sigue accesible para Ana y no genera denegaciones.
      await detail(ana, anaOrder.id);
      expect(await prisma.outboxEvent.count({ where: { eventType: 'ACCESS_DENIED' } })).toBe(1);
    });

    it('RN-21/IDOR: identifiers must be UUID v4; order numbers and injection payloads are rejected before any lookup', async () => {
      const { orderNumber } = await seedOrder(prisma, ana.userId);
      for (const candidate of [
        orderNumber,
        '1',
        '00000000-0000-0000-0000-000000000000',
        '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
        "'%20OR%201=1--",
        '..%2F..%2Fcart',
      ]) {
        const response = await get(bruno, `/orders/${candidate}`);
        expect(response.status, candidate).toBe(400);
        expect(parse<ApiErrorResponse>(response).code, candidate).toBe('VALIDATION_ERROR');
      }
      expect(await prisma.outboxEvent.count()).toBe(0);
    });

    it('RN-22: the customer cannot modify or cancel an order through any method', async () => {
      const { id } = await seedOrder(prisma, ana.userId);
      const attempts: [method: 'patch' | 'put' | 'delete' | 'post', path: string][] = [
        ['patch', `/orders/${id}`],
        ['put', `/orders/${id}`],
        ['delete', `/orders/${id}`],
        ['post', `/orders/${id}/cancel`],
        ['patch', `/orders/${id}/status`],
      ];
      for (const [method, path] of attempts) {
        const response = await mutate(ana, method, path, { status: 'CANCELADO', total: '0.00' });
        expect(response.status, `${method} ${path}`).toBe(404);
      }
      const row = await prisma.order.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('PAGADO');
      expect(row.cancelledAt).toBeNull();
      expect(row.total.toFixed(2)).toBe('150.00');
    });

    it('M06 mínimo: ADMIN lists every customer order read-only; CLIENTE gets 403 and anonymous 401', async () => {
      const base = new Date('2026-11-10T10:00:00.000Z');
      const older = await seedOrder(prisma, ana.userId, { createdAt: minutesAfter(base, 0) });
      const newer = await seedOrder(prisma, bruno.userId, { createdAt: minutesAfter(base, 1) });

      const listed = await get(admin, '/admin/orders');
      expect(listed.status).toBe(200);
      const page = parse<OrderHistoryPage>(listed);
      expect(page.meta).toEqual({ page: 1, pageSize: 10, totalItems: 2, totalPages: 1 });
      expect(page.items.map((order) => order.id)).toEqual([newer.id, older.id]);
      expect(Object.keys(page.items[0]!)).not.toContain('shipping');

      expect((await get(ana, '/admin/orders')).status).toBe(403);
      await get(undefined, '/admin/orders').expect(401);
      // Lista blanca de la consulta: el administrador solo elige la página.
      expect((await get(admin, '/admin/orders?userId=x')).status).toBe(400);
      // Solo lectura: no existen rutas de escritura administrativas sobre pedidos.
      for (const method of ['post', 'patch', 'delete'] as const) {
        const response = await supertest(server)
          [method]('/admin/orders')
          .set('Cookie', admin.cookieHeader())
          .set('Origin', ORIGIN);
        expect(response.status).toBe(404);
      }
      expect(await prisma.order.count()).toBe(2);
    });

    it('RS02/sessions: anonymous, forged, revoked, idle, expired and admin sessions are refused', async () => {
      const { id } = await seedOrder(prisma, ana.userId);
      for (const path of ['/orders', `/orders/${id}`]) {
        await get(undefined, path).expect(401);
        const [header, payload] = ana.cookieHeader().split(';')[0]!.split('=')[1]!.split('.');
        await supertest(server)
          .get(path)
          .set('Cookie', `${cookieNames.access}=${header}.${payload}.`)
          .expect(401);
        // El rol ADMIN consulta pedidos en M06 (P08), no en el historial del cliente.
        const asAdmin = await get(admin, path);
        expect(asAdmin.status).toBe(403);
        expect(asAdmin.text).not.toContain(id);
      }

      for (const state of ['revoked', 'idle', 'absolute'] as const) {
        const session = await buyer();
        await seedOrder(prisma, session.userId);
        await get(session, '/orders').expect(200);
        if (state === 'revoked') {
          await identityDb.query(
            `UPDATE identity.auth_sessions SET revoked_at = NOW(), revoke_reason = 'TEST' WHERE user_id = $1`,
            [session.userId],
          );
        } else if (state === 'idle') {
          await identityDb.query(
            `UPDATE identity.auth_sessions SET last_activity_at = NOW() - INTERVAL '31 minutes' WHERE user_id = $1`,
            [session.userId],
          );
        } else {
          await identityDb.query(
            `UPDATE identity.auth_sessions SET absolute_expires_at = NOW() - INTERVAL '1 second' WHERE user_id = $1`,
            [session.userId],
          );
        }
        const refused = await get(session, '/orders');
        expect(refused.status, state).toBe(401);
        expect(refused.text, state).not.toContain('items');
      }

      const identityUrl = config.identityUrl;
      config.identityUrl = new URL('http://127.0.0.1:9');
      try {
        await get(ana, '/orders').expect(503);
      } finally {
        config.identityUrl = identityUrl;
      }
    });

    it('RS04: hostile text is returned as JSON data, never as HTML', async () => {
      const payload = '<script>alert(1)</script>';
      const { id } = await seedOrder(prisma, ana.userId, {
        lines: [
          {
            productId: MIC,
            name: `<img src=x onerror=alert(1)>${payload}`,
            unitPrice: '10.00',
            quantity: 1,
          },
        ],
        shippingReferences: payload,
      });
      const response = await get(ana, `/orders/${id}`).expect(200);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      const body = parse<OrderDetail>(response);
      expect(body.items[0]!.name).toBe(`<img src=x onerror=alert(1)>${payload}`);
      expect(body.shipping.references).toBe(payload);
    });

    it('D-M05-06/RS11: sensitive responses are never cached and errors expose no internals', async () => {
      const { id } = await seedOrder(prisma, ana.userId);
      for (const response of [
        await get(ana, '/orders'),
        await get(ana, `/orders/${id}`),
        await get(bruno, `/orders/${id}`),
        await get(ana, '/orders?page=abc'),
        await get(undefined, '/orders'),
      ]) {
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['pragma']).toBe('no-cache');
        expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
        if (response.status >= 400) {
          expect(response.text).not.toMatch(/prisma|stack|select |postgres|at \w+ \(/i);
        }
      }
    });
  },
);
