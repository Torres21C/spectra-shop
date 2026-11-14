import type { Server } from 'node:http';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { ApiErrorResponse, ProductDetail, ProductPage } from '@spectra/contracts';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

describe.skipIf(!process.env.DATABASE_URL)('catalog HTTP integration with PostgreSQL', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
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
  });

  afterAll(async () => {
    await app.close();
  });

  it('CA-M01-01 lists only active products with server-controlled pagination', async () => {
    const response = await supertest(server).get('/products').expect(200);
    const body = parseJson<ProductPage>(response.text);
    expect(body.items).toHaveLength(12);
    expect(body.items.some((product) => product.name === 'Teclado Legacy')).toBe(false);
    expect(body.meta).toMatchObject({ page: 1, pageSize: 12, totalItems: 13, totalPages: 2 });

    const secondPageResponse = await supertest(server)
      .get('/products')
      .query({ page: 2 })
      .expect(200);
    expect(parseJson<ProductPage>(secondPageResponse.text).items).toHaveLength(1);
  });

  it('CA-M01-02 searches case-insensitively in product text', async () => {
    const response = await supertest(server)
      .get('/products')
      .query({ search: 'TECLADO' })
      .expect(200);
    const body = parseJson<ProductPage>(response.text);
    expect(body.items).toHaveLength(2);
    expect(
      body.items.every((product) => /teclado/i.test(`${product.name} ${product.description}`)),
    ).toBe(true);
  });

  it('CA-M01-03 filters active products by active category', async () => {
    const response = await supertest(server)
      .get('/products')
      .query({ category: 'audio' })
      .expect(200);
    const body = parseJson<ProductPage>(response.text);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((product) => product.category.slug === 'audio')).toBe(true);
  });

  it('CA-M01-04 and CA-M01-05 return detail, GTQ price and exhausted availability', async () => {
    const response = await supertest(server)
      .get('/products/20000000-0000-4000-8000-000000000003')
      .expect(200);
    const body = parseJson<ProductDetail>(response.text);
    expect(body).toMatchObject({
      name: 'Audífonos Nebula',
      price: '799.00',
      currency: 'GTQ',
      availability: 'OUT_OF_STOCK',
      sku: 'SP-AUD-001',
    });
    expect(body.description.length).toBeGreaterThan(0);
  });

  it('CA-M01-06 treats SQL injection syntax as literal text', async () => {
    const response = await supertest(server)
      .get('/products')
      .query({ search: "' OR '1'='1" })
      .expect(200);
    expect(parseJson<ProductPage>(response.text).items).toEqual([]);
  });

  it('accepts script-shaped search as inert text for safe React rendering', async () => {
    const response = await supertest(server)
      .get('/products')
      .query({ search: '<script>' })
      .expect(200);
    expect(parseJson<ProductPage>(response.text).items).toEqual([]);
  });

  it('CA-M01-08 gives inactive and unknown products the same public 404', async () => {
    const inactiveResponse = await supertest(server)
      .get('/products/20000000-0000-4000-8000-000000000014')
      .expect(404);
    const unknownResponse = await supertest(server)
      .get('/products/ffffffff-ffff-4fff-8fff-ffffffffffff')
      .expect(404);
    const inactive = parseJson<ApiErrorResponse>(inactiveResponse.text);
    const unknown = parseJson<ApiErrorResponse>(unknownResponse.text);
    expect({ code: inactive.code, message: inactive.message }).toEqual({
      code: unknown.code,
      message: unknown.message,
    });
  });

  it('rejects invalid and undeclared query parameters', async () => {
    const response = await supertest(server)
      .get('/products')
      .query({ page: 0, pageSize: 500 })
      .expect(400);
    const body = parseJson<ApiErrorResponse>(response.text);
    expect(body).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Parámetros inválidos' });
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
