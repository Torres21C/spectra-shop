import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { ValidationPipe, type ExecutionContext, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import cookieParser from 'cookie-parser';
import supertest from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const CATEGORY = '10000000-0000-4000-8000-000000000001';
const ORIGIN = 'http://127.0.0.1:5173';
const CSRF = 'synthetic-csrf-token-for-admin-tests';
const ADMIN = { userId: randomUUID(), sessionId: randomUUID(), role: 'ADMIN' as const };
const XSS = '<img src=x onerror=alert(1)>';

function product(overrides: Record<string, unknown> = {}) {
  return {
    sku: `TST-M06-${randomUUID().slice(0, 8).toUpperCase()}`,
    name: 'Producto de prueba M06',
    categoryId: CATEGORY,
    price: '199.90',
    stock: 7,
    ...overrides,
  };
}

describe.skipIf(!process.env.DATABASE_URL)(
  'M06/M07 mínimo: alta de productos ADMIN con outbox y relay (PostgreSQL real)',
  () => {
    let app: INestApplication;
    let server: Server;
    let fixtures: PrismaClient;
    let relay: import('./audit-relay.service.js').AuditRelayService;

    beforeAll(async () => {
      const [{ AppModule }, { AdminAccessGuard }, { AuditRelayService }, { createFixtureClient }] =
        await Promise.all([
          import('../app.module.js'),
          import('./admin-access.guard.js'),
          import('./audit-relay.service.js'),
          import('../test-support/fixture-client.js'),
        ]);
      // La sesión real (JWT ES256 + Identity) se valida en el stack E2E; aquí se fija un ADMIN.
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideGuard(AdminAccessGuard)
        .useValue({
          canActivate: (context: ExecutionContext) => {
            context.switchToHttp().getRequest<{ auth?: unknown }>().auth = ADMIN;
            return true;
          },
        })
        .compile();
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
      relay = app.get(AuditRelayService);
      fixtures = createFixtureClient();
    });

    async function cleanup(): Promise<void> {
      await fixtures.$executeRaw`DROP TRIGGER IF EXISTS m06_block_outbox ON "catalog"."outbox_events"`;
      await fixtures.$executeRaw`DROP FUNCTION IF EXISTS "catalog"."m06_block_outbox"()`;
      await fixtures.outboxEvent.deleteMany();
      await fixtures.product.deleteMany({ where: { sku: { startsWith: 'TST-M06-' } } });
    }

    afterEach(cleanup);

    afterAll(async () => {
      if (fixtures) await cleanup();
      await app?.close();
      await fixtures?.$disconnect();
    });

    const create = (body: unknown, headers: Record<string, string> = {}) =>
      supertest(server)
        .post('/admin/products')
        .set('Origin', ORIGIN)
        .set('Cookie', `spectra-csrf-dev=${CSRF}`)
        .set('X-CSRF-Token', CSRF)
        .set(headers)
        .send(body as object);

    it('RF-030: creates an active product visible in the public catalog with PRODUCT_CREATED in the same transaction', async () => {
      const body = product({ name: XSS, description: 'Descripción de prueba' });
      const response = await create(body);
      expect(response.status).toBe(201);
      const created = response.body as { id: string; sku: string; name: string; isActive: boolean };
      // CA-M06-07: el nombre se guarda como texto literal (la Web lo escapa al mostrarlo).
      expect(created).toMatchObject({
        sku: body.sku,
        name: XSS,
        price: '199.90',
        stock: 7,
        isActive: true,
      });

      const visible = await supertest(server).get(`/products/${created.id}`).expect(200);
      expect(visible.body).toMatchObject({ id: created.id, sku: body.sku, name: XSS });

      const events = await fixtures.outboxEvent.findMany({ where: { resourceId: created.id } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        eventType: 'PRODUCT_CREATED',
        result: 'EXITO',
        actorId: ADMIN.userId,
        actorRole: 'ADMIN',
        resourceType: 'product',
        publishedAt: null,
      });
      expect(events[0]!.metadata).toEqual({
        sku: body.sku,
        name: XSS,
        price: '199.90',
        stock: 7,
        categoryId: CATEGORY,
        isActive: true,
      });
      expect(JSON.stringify(events[0])).not.toMatch(/csrf|cookie|token|authorization/i);
    });

    it('CA-M06-02: a duplicate SKU is rejected with 409 and no second event', async () => {
      const body = product();
      expect((await create(body)).status).toBe(201);
      const duplicate = await create({ ...body, name: 'Otro nombre' });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body).toMatchObject({ code: 'SKU_DUPLICATED' });
      expect(await fixtures.product.count({ where: { sku: body.sku } })).toBe(1);
      expect(await fixtures.outboxEvent.count()).toBe(1);
    });

    it.each([
      ['an undeclared field (mass assignment)', product({ isActive: false })],
      ['an undeclared id', product({ id: randomUUID() })],
      ['a lowercase SKU', product({ sku: 'tst-m06-low' })],
      ['a short name', product({ name: 'ab' })],
      ['a zero price', product({ price: '0.00' })],
      ['a price with three decimals', product({ price: '1.999' })],
      ['a negative stock (CA-M06-04)', product({ stock: -1 })],
      ['a non-integer stock', product({ stock: 1.5 })],
      ['a stock above 9999', product({ stock: 10_000 })],
      ['a non-UUID category', product({ categoryId: 'audio' })],
    ])('rejects %s with 400 and writes nothing', async (_label, body) => {
      const response = await create(body);
      expect(response.status).toBe(400);
      expect(await fixtures.product.count({ where: { sku: { startsWith: 'TST-M06-' } } })).toBe(0);
      expect(await fixtures.outboxEvent.count()).toBe(0);
    });

    it('rejects an unknown category with 400 INVALID_CATEGORY', async () => {
      const response = await create(product({ categoryId: randomUUID() }));
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'INVALID_CATEGORY' });
      expect(await fixtures.outboxEvent.count()).toBe(0);
    });

    it.each([
      ['without the CSRF header', { 'X-CSRF-Token': '' }],
      ['with a mismatching CSRF token', { 'X-CSRF-Token': 'x'.repeat(CSRF.length) }],
      ['from a foreign Origin', { Origin: 'https://evil.example' }],
    ])('RS05: rejects a write %s with 403 and writes nothing', async (_label, headers) => {
      const response = await create(product(), headers);
      expect(response.status).toBe(403);
      expect(await fixtures.product.count({ where: { sku: { startsWith: 'TST-M06-' } } })).toBe(0);
    });

    it('is atomic: if the outbox write fails, the product is not created (fail-closed)', async () => {
      await fixtures.$executeRaw`CREATE OR REPLACE FUNCTION "catalog"."m06_block_outbox"() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic outbox failure'; END $$`;
      await fixtures.$executeRaw`CREATE TRIGGER m06_block_outbox BEFORE INSERT ON "catalog"."outbox_events"
        FOR EACH ROW EXECUTE FUNCTION "catalog"."m06_block_outbox"()`;
      const body = product();
      const response = await create(body);
      expect(response.status).toBe(500);
      expect(JSON.stringify(response.body)).not.toContain('synthetic outbox failure');
      expect(await fixtures.product.count({ where: { sku: body.sku } })).toBe(0);
    });

    describe('audit relay (idempotent, at-least-once)', () => {
      let audit: HttpServer;
      const received: Array<{ token: string | undefined; ids: string[] }> = [];
      let status = 202;

      beforeAll(async () => {
        audit = createServer((request: IncomingMessage, response) => {
          const chunks: Buffer[] = [];
          request.on('data', (chunk: Buffer) => chunks.push(chunk));
          request.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              events: Array<{ id: string }>;
            };
            received.push({
              token: request.headers['x-spectra-internal-token'] as string | undefined,
              ids: body.events.map((event) => event.id),
            });
            response.writeHead(status, { 'content-type': 'application/json' });
            response.end('{}');
          });
        });
        await new Promise<void>((resolve) => audit.listen(0, '127.0.0.1', resolve));
        process.env.AUDIT_INTERNAL_URL = `http://127.0.0.1:${(audit.address() as AddressInfo).port}`;
        process.env.SPECTRA_INTERNAL_TOKEN ??= 'relay-test-internal-token-0123456789abcdef';
      });

      afterAll(async () => {
        await new Promise<void>((resolve) => audit.close(() => resolve()));
      });

      it('delivers pending events once, marks them published and never resends them', async () => {
        received.length = 0;
        status = 202;
        const first = await create(product());
        const second = await create(product());
        expect([first.status, second.status]).toEqual([201, 201]);
        const report = await relay.runOnce();
        expect(report).toEqual({ delivered: 2, failed: false, skipped: false });
        expect(received).toHaveLength(1);
        expect(received[0]!.token).toBe(process.env.SPECTRA_INTERNAL_TOKEN);
        expect(await fixtures.outboxEvent.count({ where: { publishedAt: null } })).toBe(0);
        expect(await relay.runOnce()).toEqual({ delivered: 0, failed: false, skipped: false });
        expect(received).toHaveLength(1);
      });

      it('keeps events pending when audit-service fails and retries them after the backoff', async () => {
        received.length = 0;
        status = 503;
        expect((await create(product())).status).toBe(201);
        const now = Date.now();
        expect(await relay.runOnce(now)).toEqual({ delivered: 0, failed: true, skipped: false });
        expect(await fixtures.outboxEvent.count({ where: { publishedAt: null } })).toBe(1);
        // Durante el backoff no se reintenta.
        expect(await relay.runOnce(now + 10)).toEqual({
          delivered: 0,
          failed: false,
          skipped: true,
        });
        status = 202;
        const retried = await relay.runOnce(now + 61_000);
        expect(retried).toEqual({ delivered: 1, failed: false, skipped: false });
        // El mismo id viajó dos veces (al menos una vez); audit-service lo deduplica por id.
        expect(received.map((entry) => entry.ids)).toEqual([received[0]!.ids, received[0]!.ids]);
        expect(await fixtures.outboxEvent.count({ where: { publishedAt: null } })).toBe(0);
      });
    });
  },
);
