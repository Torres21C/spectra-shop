import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:https';
import https from 'node:https';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import supertest, { type Agent, type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ORIGIN = 'https://127.0.0.1:5173';
const USER_ONE = {
  fullName: 'Ana Torres',
  email: 'ana.synthetic@example.test',
  password: 'Nebula segura 2026!',
  passwordConfirmation: 'Nebula segura 2026!',
  academicDataAccepted: true,
};
const USER_TWO = {
  fullName: 'Bruno López',
  email: 'bruno.synthetic@example.test',
  password: 'Prisma segura 2026!',
  passwordConfirmation: 'Prisma segura 2026!',
  academicDataAccepted: true,
};

function cookieValue(response: Response, name: string): string {
  const headerRecord = response.headers as unknown as Record<string, unknown>;
  const headers = headerRecord['set-cookie'];
  const values = Array.isArray(headers)
    ? headers.filter((value): value is string => typeof value === 'string')
    : typeof headers === 'string'
      ? [headers]
      : [];
  const cookie = values.find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Cookie ${name} ausente`);
  return cookie.split(';', 1)[0]!;
}

function parseJson<T>(response: Response): T {
  return JSON.parse(response.text) as T;
}

describe.skipIf(!process.env.IDENTITY_DATABASE_URL)(
  'M02 identity HTTPS integration with PostgreSQL',
  () => {
    let app: INestApplication;
    let server: Server;
    let certificate: string;
    // DT-09: cliente de fixtures separado (rol migrador); la aplicación usa el rol de ejecución.
    let prisma: import('../generated/identity-client/index.js').PrismaClient;

    async function csrf(agent: Agent): Promise<string> {
      const response = await agent.get('/auth/csrf').ca(certificate).expect(200);
      return parseJson<{ csrfToken: string }>(response).csrfToken;
    }

    async function register(agent: Agent, body: Record<string, unknown>): Promise<Response> {
      const token = await csrf(agent);
      return agent
        .post('/auth/register')
        .ca(certificate)
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', token)
        .send(body);
    }

    async function login(agent: Agent, email: string, password: string, returnTo?: string) {
      const token = await csrf(agent);
      return agent
        .post('/auth/login')
        .ca(certificate)
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', token)
        .send({ email, password, ...(returnTo ? { returnTo } : {}) });
    }

    beforeAll(async () => {
      process.env.COOKIE_SECURE = 'true';
      process.env.IDENTITY_ALLOW_EPHEMERAL_KEYS = 'true';
      process.env.CORS_ORIGINS = ORIGIN;
      const [{ AppModule }, { createFixtureClient }] = await Promise.all([
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
      prisma = createFixtureClient();
      await prisma.outboxEvent.deleteMany();
      await prisma.refreshToken.deleteMany();
      await prisma.authSession.deleteMany();
      await prisma.user.deleteMany();

      const directory = mkdtempSync(join(tmpdir(), 'spectra-https-'));
      const keyPath = join(directory, 'key.pem');
      const certPath = join(directory, 'cert.pem');
      execFileSync('openssl', [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ]);
      certificate = readFileSync(certPath, 'utf8');
      server = https.createServer(
        { key: readFileSync(keyPath), cert: certificate },
        app.getHttpAdapter().getInstance() as RequestListener,
      );
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    });

    afterAll(async () => {
      if (server !== undefined) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      if (app !== undefined) await app.close();
      if (prisma !== undefined) await prisma.$disconnect();
    });

    it('CA-M02-01 rejects role and isAdmin, then assigns CLIENTE server-side', async () => {
      const agent = supertest.agent(server);
      await register(agent, { ...USER_ONE, role: 'ADMIN' }).then((response) =>
        expect(response.status).toBe(400),
      );
      await register(agent, { ...USER_ONE, isAdmin: true }).then((response) =>
        expect(response.status).toBe(400),
      );
      await register(agent, USER_ONE).then((response) => expect(response.status).toBe(201));
      await register(agent, USER_TWO).then((response) => expect(response.status).toBe(201));
      const users = await prisma.user.findMany({
        include: { role: true },
        orderBy: { emailNormalized: 'asc' },
      });
      expect(users).toHaveLength(2);
      expect(users.every((user) => user.role.code === 'CLIENTE')).toBe(true);
    });

    it('CA-M02-02 rejects an eleven-character password', async () => {
      const agent = supertest.agent(server);
      const response = await register(agent, {
        ...USER_ONE,
        email: 'short.synthetic@example.test',
        password: '12345678901',
        passwordConfirmation: '12345678901',
      });
      expect(response.status).toBe(400);
    });

    it('CA-M02-03 persists Argon2id hashes and never plaintext', async () => {
      const user = await prisma.user.findUniqueOrThrow({
        where: { emailNormalized: USER_ONE.email },
      });
      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      expect(user.passwordHash).not.toContain(USER_ONE.password);
    });

    it('CA-M02-04 prevents enumeration with identical public errors', async () => {
      const wrong = await login(supertest.agent(server), USER_ONE.email, 'incorrect-password');
      const unknown = await login(
        supertest.agent(server),
        'unknown@example.test',
        'incorrect-password',
      );
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      const wrongBody = parseJson<{ code: string; message: string }>(wrong);
      const unknownBody = parseJson<{ code: string; message: string }>(unknown);
      expect({ code: wrongBody.code, message: wrongBody.message }).toEqual({
        code: unknownBody.code,
        message: unknownBody.message,
      });
    });

    it('CA-M02-05 returns AUTH_LOCKOUT on the sixth failure and audits it', async () => {
      const agent = supertest.agent(server);
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await login(agent, USER_TWO.email, 'incorrect-password').then((response) =>
          expect(response.status).toBe(401),
        );
      }
      const sixth = await login(agent, USER_TWO.email, 'incorrect-password');
      expect(sixth.status).toBe(429);
      expect(parseJson<{ code: string }>(sixth).code).toBe('AUTH_LOCKOUT');
      expect(await prisma.outboxEvent.count({ where: { eventType: 'AUTH_LOCKOUT' } })).toBe(1);
    });

    it('CA-M02-06 and CA-M02-07 use real HTTPS cookies and revoke logout immediately', async () => {
      const agent = supertest.agent(server);
      const signedIn = await login(agent, USER_ONE.email, USER_ONE.password, '#/pedidos');
      expect(signedIn.status).toBe(201);
      expect(parseJson<{ returnTo: string }>(signedIn).returnTo).toBe('#/pedidos');
      const access = cookieValue(signedIn, '__Host-spectra-access');
      const signedInHeaders = signedIn.headers as unknown as Record<string, unknown>;
      const setCookies = signedInHeaders['set-cookie'];
      const cookieHeaders = Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : [];
      for (const header of cookieHeaders) {
        expect(header).toContain('HttpOnly');
        expect(header).toContain('Secure');
        expect(header).toContain('SameSite=Strict');
        expect(header).toContain('Path=/');
      }
      const token = await csrf(agent);
      await agent
        .post('/auth/logout')
        .ca(certificate)
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', token)
        .expect(201);
      await supertest(server).get('/auth/me').ca(certificate).set('Cookie', access).expect(401);
    });

    it('CA-M02-08 isolates two profiles and rejects an external identifier', async () => {
      const first = supertest.agent(server);
      const second = supertest.agent(server);
      await login(first, USER_ONE.email, USER_ONE.password).then((response) =>
        expect(response.status).toBe(201),
      );
      await prisma.user.update({
        where: { emailNormalized: USER_TWO.email },
        data: { failedLoginCount: 0, failedLoginWindowStarted: null, lockedUntil: null },
      });
      await login(second, USER_TWO.email, USER_TWO.password).then((response) =>
        expect(response.status).toBe(201),
      );
      const one = await first.get('/auth/me').ca(certificate).expect(200);
      const two = await second.get('/auth/me').ca(certificate).expect(200);
      const profileOne = parseJson<{ id: string; email: string }>(one);
      const profileTwo = parseJson<{ id: string; email: string }>(two);
      expect(profileOne.email).toBe(USER_ONE.email);
      expect(profileTwo.email).toBe(USER_TWO.email);
      expect(profileOne.id).not.toBe(profileTwo.id);
      await first.get(`/auth/me?userId=${profileTwo.id}`).ca(certificate).expect(400);
    });

    it('CA-M02-09 ignores protocol-relative return targets', async () => {
      const response = await login(
        supertest.agent(server),
        USER_ONE.email,
        USER_ONE.password,
        '//sitio-externo.test',
      );
      expect(response.status).toBe(201);
      expect(parseJson<{ returnTo: string }>(response).returnTo).toBe('#/');
    });

    it('enforces CSRF token and trusted Origin', async () => {
      await supertest(server)
        .post('/auth/login')
        .ca(certificate)
        .send({ email: USER_ONE.email, password: USER_ONE.password })
        .expect(403);
      const agent = supertest.agent(server);
      const token = await csrf(agent);
      await agent
        .post('/auth/login')
        .ca(certificate)
        .set('Origin', 'https://sitio-externo.test')
        .set('X-CSRF-Token', token)
        .send({ email: USER_ONE.email, password: USER_ONE.password })
        .expect(403);
    });

    it('rejects unsigned or algorithm-confused access tokens', async () => {
      const encodedHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
        'base64url',
      );
      const encodedPayload = Buffer.from(
        JSON.stringify({
          sub: '00000000-0000-4000-8000-000000000001',
          sid: '00000000-0000-4000-8000-000000000002',
          role: 'ADMIN',
          jti: '00000000-0000-4000-8000-000000000003',
          exp: Math.floor(Date.now() / 1000) + 900,
        }),
      ).toString('base64url');
      const forged = `__Host-spectra-access=${encodedHeader}.${encodedPayload}.`;
      await supertest(server).get('/auth/me').ca(certificate).set('Cookie', forged).expect(401);
    });

    it('rotates refresh tokens and revokes the family on reuse', async () => {
      const agent = supertest.agent(server);
      const signedIn = await login(agent, USER_ONE.email, USER_ONE.password);
      const oldRefresh = cookieValue(signedIn, '__Host-spectra-refresh');
      const token = await csrf(agent);
      await agent
        .post('/auth/refresh')
        .ca(certificate)
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', token)
        .expect(201);
      const csrfCookie = cookieValue(
        await agent.get('/auth/csrf').ca(certificate),
        '__Host-spectra-csrf',
      );
      const csrfToken = decodeURIComponent(csrfCookie.split('=', 2)[1]!);
      await supertest(server)
        .post('/auth/refresh')
        .ca(certificate)
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', csrfToken)
        .set('Cookie', [oldRefresh, csrfCookie])
        .expect(401);
    });

    it('expires sessions after 30 minutes idle and at eight hours absolute', async () => {
      const idleAgent = supertest.agent(server);
      await login(idleAgent, USER_ONE.email, USER_ONE.password);
      const idleSession = await prisma.authSession.findFirstOrThrow({
        where: { user: { emailNormalized: USER_ONE.email }, revokedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      await prisma.authSession.update({
        where: { id: idleSession.id },
        data: { lastActivityAt: new Date(Date.now() - 31 * 60_000) },
      });
      const idle = await idleAgent.get('/auth/me').ca(certificate).expect(401);
      expect(parseJson<{ code: string }>(idle).code).toBe('SESSION_EXPIRED');

      const absoluteAgent = supertest.agent(server);
      await login(absoluteAgent, USER_ONE.email, USER_ONE.password);
      const absoluteSession = await prisma.authSession.findFirstOrThrow({
        where: { user: { emailNormalized: USER_ONE.email }, revokedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      await prisma.authSession.update({
        where: { id: absoluteSession.id },
        data: { absoluteExpiresAt: new Date(Date.now() - 1) },
      });
      await absoluteAgent.get('/auth/me').ca(certificate).expect(401);
    });
  },
);
