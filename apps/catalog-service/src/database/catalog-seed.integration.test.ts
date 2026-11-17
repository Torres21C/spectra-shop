import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// M06.0: el seed de Catalog es idempotente y nunca sobrescribe productos existentes (antes restablecía
// stock y precios en cada despliegue, deshaciendo el descuento de pedidos confirmados).
// Productos del seed que ninguna otra suite usa: SP-AUD-002 (activo), SP-KEY-001 (activo) y
// SP-KEY-LEGACY (inactivo, fuera del listado público). Se restauran al terminar.
const SOLD = '20000000-0000-4000-8000-000000000004';
const EDITED = '20000000-0000-4000-8000-000000000001';
const MISSING = '20000000-0000-4000-8000-000000000014';
const PRODUCTS = [SOLD, EDITED, MISSING];
const ROOT = '/internal/catalog/stock-reservations';

describe.skipIf(!process.env.DATABASE_URL || !process.env.CATALOG_INVENTORY_TOKENS)(
  'M06.0 idempotent catalog seed with PostgreSQL',
  () => {
    let app: INestApplication;
    let server: Server;
    // El seed se ejecuta con el rol migrador (igual que el job catalog-migrate de Compose).
    let prisma: import('@prisma/client').PrismaClient;
    let seed: typeof import('./catalog-seed.js');
    let token: string;
    let original: Awaited<ReturnType<typeof snapshot>>;

    async function snapshot() {
      const [categories, products] = await Promise.all([
        prisma.category.findMany({ orderBy: { id: 'asc' } }),
        prisma.product.findMany({ orderBy: { id: 'asc' } }),
      ]);
      // Filas completas, incluido updated_at: cualquier UPDATE del seed se detectaría.
      return JSON.parse(JSON.stringify({ categories, products })) as {
        categories: Record<string, unknown>[];
        products: (Record<string, unknown> & { id: string; stock: number })[];
      };
    }

    async function sell(productId: string, quantity: number): Promise<string> {
      const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
      const id = randomUUID();
      const call = (path: string) =>
        supertest(server).post(path).set('X-Spectra-Internal-Token', token);
      expect(
        (
          await call(ROOT).send({
            reservationId: id,
            lines: [{ productId, quantity, expectedUnitPrice: product.price.toFixed(2) }],
          })
        ).status,
      ).toBe(201);
      expect((await call(`${ROOT}/${id}/confirm`)).status).toBe(200);
      expect((await call(`${ROOT}/${id}/fulfill`).send({ orderId: randomUUID() })).status).toBe(
        201,
      );
      return id;
    }

    beforeAll(async () => {
      process.env.RESERVATION_SWEEP_INTERVAL_MS = '0';
      process.env.RESERVATION_DELIVERY_MONITOR_INTERVAL_MS = '0';
      token = process.env.CATALOG_INVENTORY_TOKENS!.split(',')[0]!.trim();
      const [{ InternalAppModule }, fixtureModule, seedModule] = await Promise.all([
        import('../internal-app.module.js'),
        import('../test-support/fixture-client.js'),
        import('./catalog-seed.js'),
      ]);
      seed = seedModule;
      app = (await Test.createTestingModule({ imports: [InternalAppModule] }).compile())
        .createNestApplication()
        .useGlobalPipes(
          new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
        );
      await app.init();
      server = app.getHttpServer() as Server;
      prisma = fixtureModule.createFixtureClient();
      await seed.seedCatalog(prisma);
      original = await snapshot();
    });

    afterAll(async () => {
      if (prisma) {
        await prisma.stockReservationLine.deleteMany({ where: { productId: { in: PRODUCTS } } });
        await prisma.stockReservation.deleteMany({ where: { lines: { none: {} } } });
        for (const product of original?.products.filter((row) => PRODUCTS.includes(row.id)) ?? []) {
          await prisma.product.update({
            where: { id: product.id },
            data: {
              name: product.name as string,
              price: product.price as string,
              stock: product.stock,
              isActive: product.isActive as boolean,
            },
          });
        }
      }
      await app?.close();
      await prisma?.$disconnect();
    });

    it('running the seed twice after a confirmed order and product edits changes no existing row', async () => {
      const before = await prisma.product.findUniqueOrThrow({ where: { id: SOLD } });
      await sell(SOLD, 2);
      await prisma.product.update({
        where: { id: EDITED },
        data: { price: '111.11', name: 'Producto editado por administración', isActive: false },
      });
      const state = await snapshot();
      expect(state.products.find((row) => row.id === SOLD)!.stock).toBe(before.stock - 2);

      expect(await seed.seedCatalog(prisma)).toEqual({ categoriesCreated: 0, productsCreated: 0 });
      expect(await seed.seedCatalog(prisma)).toEqual({ categoriesCreated: 0, productsCreated: 0 });

      expect(await snapshot()).toEqual(state);
      expect(await prisma.product.findUniqueOrThrow({ where: { id: EDITED } })).toMatchObject({
        name: 'Producto editado por administración',
        isActive: false,
      });
    });

    it('only inserts seed rows that are missing, with the seed values', async () => {
      const lines = await prisma.stockReservationLine.count({ where: { productId: MISSING } });
      expect(lines).toBe(0);
      const expected = seed.CATALOG_SEED_PRODUCTS.find((product) => product.id === MISSING)!;
      await prisma.product.delete({ where: { id: MISSING } });
      const others = (await snapshot()).products;

      expect(await seed.seedCatalog(prisma)).toEqual({ categoriesCreated: 0, productsCreated: 1 });
      expect(await seed.seedCatalog(prisma)).toEqual({ categoriesCreated: 0, productsCreated: 0 });

      const recreated = await prisma.product.findUniqueOrThrow({ where: { id: MISSING } });
      expect(recreated).toMatchObject({
        sku: expected.sku,
        name: expected.name,
        stock: expected.stock,
        isActive: expected.isActive,
      });
      expect(recreated.price.toFixed(2)).toBe(expected.price);
      const after = (await snapshot()).products.filter((row) => row.id !== MISSING);
      expect(after).toEqual(others);
    });
  },
);
