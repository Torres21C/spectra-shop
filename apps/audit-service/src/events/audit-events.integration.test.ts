import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/audit-client/index.js';

const TOKEN = process.env.SPECTRA_INTERNAL_TOKENS?.split(',')[0]?.trim() ?? '';

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    sourceService: 'catalog',
    eventType: 'PRODUCT_CREATED',
    result: 'EXITO',
    actorId: randomUUID(),
    actorRole: 'ADMIN',
    resourceType: 'product',
    resourceId: randomUUID(),
    sourceIp: '172.18.0.5',
    requestId: randomUUID(),
    metadata: { sku: 'SP-AUDIT-TEST', name: 'Prueba', price: '10.00', stock: 1 },
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

describe.skipIf(!process.env.AUDIT_DATABASE_URL)(
  'M07 mínimo: audit-service with real PostgreSQL (runtime role)',
  () => {
    let publicApp: INestApplication;
    let internalApp: INestApplication;
    let fixtures: PrismaClient;
    let runtime: PrismaClient;

    beforeAll(async () => {
      const [{ AppModule }, { InternalAppModule }, { createFixtureClient }, client] =
        await Promise.all([
          import('../app.module.js'),
          import('../internal-app.module.js'),
          import('../test-support/fixture-client.js'),
          import('../generated/audit-client/index.js'),
        ]);
      const pipe = new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      });
      publicApp = (
        await Test.createTestingModule({ imports: [AppModule] }).compile()
      ).createNestApplication();
      publicApp.use(cookieParser());
      publicApp.useGlobalPipes(pipe);
      await publicApp.init();
      internalApp = (
        await Test.createTestingModule({ imports: [InternalAppModule] }).compile()
      ).createNestApplication();
      internalApp.useGlobalPipes(pipe);
      await internalApp.init();
      fixtures = createFixtureClient();
      runtime = new client.PrismaClient({ datasourceUrl: process.env.AUDIT_DATABASE_URL! });
    });

    beforeEach(async () => {
      await fixtures.auditEvent.deleteMany();
    });

    afterAll(async () => {
      await fixtures?.auditEvent.deleteMany();
      await Promise.all([publicApp?.close(), internalApp?.close()]);
      await Promise.all([fixtures?.$disconnect(), runtime?.$disconnect()]);
    });

    const ingest = (body: unknown, token: string | undefined = TOKEN) => {
      const request = supertest(internalApp.getHttpServer() as Server).post(
        '/internal/audit/events',
      );
      return (token ? request.set('X-Spectra-Internal-Token', token) : request).send(
        body as object,
      );
    };

    it('ingests a batch idempotently: replaying the same event ids never duplicates rows', async () => {
      const batch = { events: [event(), event()] };
      const first = await ingest(batch);
      expect(first.status).toBe(202);
      expect(first.body).toEqual({ received: 2, inserted: 2 });
      const replay = await ingest(batch);
      expect(replay.status).toBe(202);
      expect(replay.body).toEqual({ received: 2, inserted: 0 });
      expect(await fixtures.auditEvent.count()).toBe(2);
    });

    it('rejects ingestion without the internal token (404) and invalid events (400) with no rows', async () => {
      expect((await ingest({ events: [event()] }, '')).status).toBe(404);
      expect((await ingest({ events: [event()] }, 'x'.repeat(64))).status).toBe(404);
      const invalid = await ingest({ events: [event({ metadata: { sessionId: 'abc' } })] });
      expect(invalid.status).toBe(400);
      expect(invalid.body).toMatchObject({ code: 'INVALID_AUDIT_EVENT' });
      expect(await fixtures.auditEvent.count()).toBe(0);
    });

    it('lists the latest events newest first and honours the limit', async () => {
      const { AuditEventsService } = await import('./audit-events.service.js');
      const service = publicApp.get(AuditEventsService);
      const older = event({ occurredAt: '2026-11-17T10:00:00.000Z' });
      const newer = event({ occurredAt: '2026-11-17T11:00:00.000Z' });
      expect((await ingest({ events: [older, newer] })).status).toBe(202);
      const latest = await service.latest(1);
      expect(latest).toHaveLength(1);
      expect(latest[0]).toMatchObject({ id: newer.id, eventType: 'PRODUCT_CREATED' });
    });

    it('is append-only for the runtime role: UPDATE and DELETE are denied by PostgreSQL', async () => {
      expect((await ingest({ events: [event()] })).status).toBe(202);
      await expect(
        runtime.$executeRawUnsafe(`UPDATE "audit"."audit_events" SET "result" = 'FALLO'`),
      ).rejects.toThrow(/permission denied/i);
      await expect(runtime.$executeRawUnsafe(`DELETE FROM "audit"."audit_events"`)).rejects.toThrow(
        /permission denied/i,
      );
      expect(await fixtures.auditEvent.count()).toBe(1);
    });

    it('requires a session for the admin query and exposes no write routes', async () => {
      const server = publicApp.getHttpServer() as Server;
      const anonymous = await supertest(server).get('/admin/audit-events');
      expect(anonymous.status).toBe(401);
      expect(anonymous.body).toMatchObject({ code: 'AUTH_REQUIRED' });
      for (const method of ['post', 'put', 'patch', 'delete'] as const) {
        expect((await supertest(server)[method]('/admin/audit-events')).status).toBe(404);
      }
      expect((await supertest(server).post('/internal/audit/events').send({})).status).toBe(404);
    });
  },
);
