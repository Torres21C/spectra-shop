import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { ApiErrorResponse, LoginResponse, ShoppingCart } from '@spectra/contracts';
import cookieParser from 'cookie-parser';
import { importPKCS8, SignJWT } from 'jose';
import { Pool } from 'pg';
import supertest, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const ORIGIN = 'http://127.0.0.1:5173';
const PRODUCT = '20000000-0000-4000-8000-000000000015';
const LOW_STOCK_PRODUCT = '20000000-0000-4000-8000-000000000002';
const INACTIVE_PRODUCT = '20000000-0000-4000-8000-000000000014';

function parse<T>(response: Response): T {
  return JSON.parse(response.text) as T;
}

class IdentityAgent {
  readonly cookies = new Map<string, string>();
  userId = '';

  constructor(
    readonly email: string,
    readonly password: string,
  ) {}

  cookieHeader(overrides?: Record<string, string>): string {
    const values = new Map(this.cookies);
    for (const [name, value] of Object.entries(overrides ?? {})) values.set(name, value);
    return [...values].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async csrf(): Promise<string> {
    const response = await this.identity('/auth/csrf');
    if (!response.ok) throw new Error('No fue posible emitir CSRF sintético');
    return ((await response.json()) as { csrfToken: string }).csrfToken;
  }

  async register(): Promise<void> {
    const token = await this.csrf();
    const response = await this.identity('/auth/register', {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify({
        fullName: 'Cliente sintético carrito',
        email: this.email,
        password: this.password,
        passwordConfirmation: this.password,
        academicDataAccepted: true,
      }),
    });
    if (response.status !== 201) throw new Error(`Registro sintético falló: ${response.status}`);
  }

  async login(): Promise<void> {
    const token = await this.csrf();
    const response = await this.identity('/auth/login', {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify({ email: this.email, password: this.password }),
    });
    if (response.status !== 201) throw new Error(`Login sintético falló: ${response.status}`);
    this.userId = ((await response.json()) as LoginResponse).user.id;
  }

  async logout(): Promise<void> {
    const token = await this.csrf();
    const response = await this.identity('/auth/logout', {
      method: 'POST',
      headers: this.headers(token),
      body: '{}',
    });
    if (response.status !== 201) throw new Error(`Logout sintético falló: ${response.status}`);
  }

  private headers(csrf?: string): Record<string, string> {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Cookie: this.cookieHeader(),
      ...(csrf ? { Origin: ORIGIN, 'X-CSRF-Token': csrf } : {}),
    };
  }

  private async identity(path: string, init?: RequestInit): Promise<globalThis.Response> {
    const response = await fetch(`http://identity-service:3001${path}`, {
      redirect: 'error',
      ...init,
      headers: { Cookie: this.cookieHeader(), ...(init?.headers ?? {}) },
    });
    const getSetCookie = Reflect.get(response.headers, 'getSetCookie') as
      (() => string[]) | undefined;
    const setCookies = getSetCookie?.call(response.headers) ?? [];
    for (const header of setCookies) {
      const [pair] = header.split(';', 1);
      const separator = pair?.indexOf('=') ?? -1;
      if (!pair || separator < 1) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (/Max-Age=0/i.test(header) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }
}

describe.skipIf(!process.env.COMMERCE_DATABASE_URL)(
  'M03 cart integration with real Identity, Catalog and PostgreSQL',
  () => {
    let app: INestApplication;
    let server: Server;
    let prisma: InstanceType<typeof import('../database/prisma.service.js').PrismaService>;
    let catalogDb: Pool;
    let identityDb: Pool;
    let config: typeof import('../config/commerce.config.js').commerceConfig;
    let first: IdentityAgent;
    let second: IdentityAgent;
    let admin: IdentityAgent;

    function commerce(
      agent: IdentityAgent,
      method: 'get' | 'post' | 'patch' | 'delete',
      path: string,
    ) {
      return supertest(server)[method](path).set('Cookie', agent.cookieHeader());
    }

    async function mutate(
      agent: IdentityAgent,
      method: 'post' | 'patch' | 'delete',
      path: string,
      body?: Record<string, unknown>,
    ): Promise<Response> {
      const token = await agent.csrf();
      const request = commerce(agent, method, path)
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', token)
        .set('Content-Type', 'application/json');
      return body ? request.send(body) : request.send({});
    }

    beforeAll(async () => {
      const suffix = randomUUID().slice(0, 8);
      first = new IdentityAgent(`ana.${suffix}@example.test`, 'Nebula segura 2026!');
      second = new IdentityAgent(`bruno.${suffix}@example.test`, 'Prisma segura 2026!');
      admin = new IdentityAgent(`admin.${suffix}@example.test`, 'Administrador seguro 2026!');
      catalogDb = new Pool({ connectionString: process.env.CATALOG_TEST_DATABASE_URL });
      identityDb = new Pool({ connectionString: process.env.IDENTITY_TEST_DATABASE_URL });
      await Promise.all([first.register(), second.register(), admin.register()]);
      await identityDb.query(`UPDATE identity.users SET role_id = $1 WHERE email_normalized = $2`, [
        '10000000-0000-4000-8000-000000000002',
        admin.email,
      ]);
      await Promise.all([first.login(), second.login(), admin.login()]);

      const [{ AppModule }, prismaModule, configModule] = await Promise.all([
        import('../app.module.js'),
        import('../database/prisma.service.js'),
        import('../config/commerce.config.js'),
      ]);
      config = configModule.commerceConfig;
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
      prisma = app.get(prismaModule.PrismaService);
    });

    beforeEach(async () => {
      // Datos M04 que referencian carritos (FK RESTRICT); se limpian antes de los carritos.
      await prisma.orderItem.deleteMany();
      await prisma.order.deleteMany();
      await prisma.checkoutAttempt.deleteMany();
      await prisma.outboxEvent.deleteMany();
      await prisma.cartItem.deleteMany();
      await prisma.cart.deleteMany();
      await catalogDb.query(
        `UPDATE catalog.products SET price = $1, stock = $2, is_active = true WHERE id = $3`,
        ['325.00', 10, PRODUCT],
      );
    });

    afterAll(async () => {
      if (app) await app.close();
      await Promise.all([catalogDb?.end(), identityDb?.end()]);
    });

    it('CA-M03-01, 02 and 05 calculate Q650, increment one line and reject monetary fields', async () => {
      const added = await mutate(first, 'post', '/cart/items', { productId: PRODUCT, quantity: 2 });
      expect(added.status).toBe(200);
      expect(parse<ShoppingCart>(added)).toMatchObject({ total: '650.00', itemCount: 2 });
      expect(parse<ShoppingCart>(added).items[0]).toMatchObject({
        quantity: 2,
        unitPrice: '325.00',
        subtotal: '650.00',
      });

      const incremented = await mutate(first, 'post', '/cart/items', {
        productId: PRODUCT,
        quantity: 1,
      });
      expect(incremented.status).toBe(200);
      expect(parse<ShoppingCart>(incremented)).toMatchObject({
        distinctItems: 1,
        itemCount: 3,
        total: '975.00',
      });

      const manipulated = await mutate(first, 'post', '/cart/items', {
        productId: PRODUCT,
        quantity: 1,
        price: '0.01',
        subtotal: '0.01',
        total: '0.01',
        userId: second.userId,
        role: 'ADMIN',
      });
      expect(manipulated.status).toBe(400);
      expect(parse<ApiErrorResponse>(manipulated).code).toBe('VALIDATION_ERROR');
    });

    it('CA-M03-03 and 04 reject stock excess and every invalid quantity type', async () => {
      for (const quantity of [-1, 0, 1.5, 'abc']) {
        const response = await mutate(first, 'post', '/cart/items', {
          productId: PRODUCT,
          quantity,
        });
        expect(response.status).toBe(400);
      }
      const eleven = await mutate(first, 'post', '/cart/items', {
        productId: PRODUCT,
        quantity: 11,
      });
      expect(eleven.status).toBe(400);
      const stock = await mutate(first, 'post', '/cart/items', {
        productId: LOW_STOCK_PRODUCT,
        quantity: 5,
      });
      expect(stock.status).toBe(409);
      expect(parse<ApiErrorResponse>(stock).message).toBe('Cantidad máxima disponible: 4');
    });

    it('CA-M03-06 removes a line and recalculates the total', async () => {
      const added = await mutate(first, 'post', '/cart/items', { productId: PRODUCT, quantity: 2 });
      const item = parse<ShoppingCart>(added).items[0]!;
      const removed = await mutate(first, 'delete', `/cart/items/${item.id}`);
      expect(removed.status).toBe(200);
      expect(parse<ShoppingCart>(removed)).toMatchObject({ total: '0.00', itemCount: 0 });
    });

    it('CA-M03-07 prevents IDOR with a uniform 404 for a second client', async () => {
      const added = await mutate(first, 'post', '/cart/items', { productId: PRODUCT, quantity: 1 });
      const itemId = parse<ShoppingCart>(added).items[0]!.id;
      const readOther = await commerce(second, 'get', '/cart').expect(200);
      expect(parse<ShoppingCart>(readOther).items).toEqual([]);
      const patch = await mutate(second, 'patch', `/cart/items/${itemId}`, { quantity: 2 });
      const remove = await mutate(second, 'delete', `/cart/items/${itemId}`);
      expect(patch.status).toBe(404);
      expect(remove.status).toBe(404);
      expect(parse<ApiErrorResponse>(patch).code).toBe(parse<ApiErrorResponse>(remove).code);
    });

    it('denies ADMIN and enforces CSRF token plus trusted Origin', async () => {
      await commerce(admin, 'get', '/cart').expect(403);
      await commerce(first, 'post', '/cart/items')
        .send({ productId: PRODUCT, quantity: 1 })
        .expect(403);
      const token = await first.csrf();
      await commerce(first, 'post', '/cart/items')
        .set('Origin', 'http://sitio-externo.test')
        .set('X-CSRF-Token', token)
        .send({ productId: PRODUCT, quantity: 1 })
        .expect(403);
    });

    it('rejects altered, unsigned and expired JWT before accessing the domain', async () => {
      const valid = first.cookies.get('spectra-access-dev')!;
      const parts = valid.split('.');
      const signature = parts[2]!;
      const alteredSignature = `${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
      const altered = `${parts[0]}.${parts[1]}.${alteredSignature}`;
      await supertest(server)
        .get('/cart')
        .set('Cookie', `spectra-access-dev=${altered}`)
        .expect(401);
      const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"x"}').toString('base64url')}.`;
      await supertest(server)
        .get('/cart')
        .set('Cookie', `spectra-access-dev=${unsigned}`)
        .expect(401);

      const privateKey = await importPKCS8(
        await readFile(process.env.IDENTITY_TEST_PRIVATE_KEY_PATH!, 'utf8'),
        'ES256',
      );
      const expired = await new SignJWT({ role: 'CLIENTE', sid: randomUUID() })
        .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
        .setSubject(first.userId)
        .setJti(randomUUID())
        .setIssuer('spectra-shop-identity')
        .setAudience('spectra-shop-services')
        .setIssuedAt(Math.floor(Date.now() / 1000) - 1000)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 100)
        .sign(privateKey);
      await supertest(server)
        .get('/cart')
        .set('Cookie', `spectra-access-dev=${expired}`)
        .expect(401);
    });

    it('fails closed for revoked, inactive and absolutely expired sessions', async () => {
      for (const state of ['revoked', 'idle', 'absolute'] as const) {
        const agent = new IdentityAgent(
          `${state}.${randomUUID().slice(0, 8)}@example.test`,
          'Sesion segura 2026!',
        );
        await agent.register();
        await agent.login();
        if (state === 'revoked') {
          await identityDb.query(
            `UPDATE identity.auth_sessions SET revoked_at = NOW(), revoke_reason = 'TEST' WHERE user_id = $1`,
            [agent.userId],
          );
        } else if (state === 'idle') {
          await identityDb.query(
            `UPDATE identity.auth_sessions SET last_activity_at = NOW() - INTERVAL '31 minutes' WHERE user_id = $1`,
            [agent.userId],
          );
        } else {
          await identityDb.query(
            `UPDATE identity.auth_sessions SET absolute_expires_at = NOW() - INTERVAL '1 second' WHERE user_id = $1`,
            [agent.userId],
          );
        }
        await commerce(agent, 'get', '/cart').expect(401);
      }
    });

    it('revalidates price and availability, excluding unavailable products from total', async () => {
      const added = await mutate(first, 'post', '/cart/items', { productId: PRODUCT, quantity: 2 });
      const cartId = parse<ShoppingCart>(added).id;
      await prisma.cartItem.create({
        data: { cartId, productId: INACTIVE_PRODUCT, quantity: 1 },
      });
      await catalogDb.query(`UPDATE catalog.products SET price = $1 WHERE id = $2`, [
        '400.00',
        PRODUCT,
      ]);
      const repriced = await commerce(first, 'get', '/cart').expect(200);
      expect(parse<ShoppingCart>(repriced).total).toBe('800.00');
      expect(parse<ShoppingCart>(repriced).items.find((item) => !item.available)).toMatchObject({
        productId: INACTIVE_PRODUCT,
        subtotal: '0.00',
        unavailableReason: 'INACTIVE',
      });
      await catalogDb.query(`UPDATE catalog.products SET stock = 0 WHERE id = $1`, [PRODUCT]);
      const depleted = await commerce(first, 'get', '/cart').expect(200);
      expect(parse<ShoppingCart>(depleted)).toMatchObject({
        total: '0.00',
        checkoutAllowed: false,
      });
    });

    it('serializes concurrent adds and enforces the maximum of 20 distinct lines', async () => {
      const concurrent = await Promise.all(
        Array.from({ length: 5 }, () =>
          mutate(first, 'post', '/cart/items', { productId: PRODUCT, quantity: 1 }),
        ),
      );
      expect(concurrent.every((response) => response.status === 200)).toBe(true);
      const current = await commerce(first, 'get', '/cart').expect(200);
      expect(parse<ShoppingCart>(current)).toMatchObject({ distinctItems: 1, itemCount: 5 });

      await prisma.cartItem.deleteMany();
      const cart = await prisma.cart.findFirstOrThrow({ where: { userId: first.userId } });
      await prisma.cartItem.createMany({
        data: Array.from({ length: 20 }, () => ({
          cartId: cart.id,
          productId: randomUUID(),
          quantity: 1,
        })),
      });
      const limited = await mutate(first, 'post', '/cart/items', {
        productId: PRODUCT,
        quantity: 1,
      });
      expect(limited.status).toBe(409);
      expect(parse<ApiErrorResponse>(limited).code).toBe('CART_LINE_LIMIT');
    });

    it('persists across logout/login and returns 503 when Catalog or Identity is unavailable', async () => {
      await mutate(first, 'post', '/cart/items', { productId: PRODUCT, quantity: 1 });
      await first.logout();
      await first.login();
      const restored = await commerce(first, 'get', '/cart').expect(200);
      expect(parse<ShoppingCart>(restored).itemCount).toBe(1);

      const catalogUrl = config.catalogUrl;
      config.catalogUrl = new URL('http://127.0.0.1:9');
      await commerce(first, 'get', '/cart').expect(503);
      config.catalogUrl = catalogUrl;

      const identityUrl = config.identityUrl;
      config.identityUrl = new URL('http://127.0.0.1:9');
      await commerce(first, 'get', '/cart').expect(503);
      config.identityUrl = identityUrl;
    });
  },
);
