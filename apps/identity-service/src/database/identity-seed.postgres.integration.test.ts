import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/identity-client/index.js';
import { seedIdentity } from './identity-seed.js';

const databaseUrl = process.env.IDENTITY_SEED_TEST_DATABASE_URL;
// La prueba borra filas sintéticas: solo se admite la base desechable de infra/testing/identity-seed.compose.yaml.
const disposableDatabase = 'spectra_identity_seed_test';
if (databaseUrl && new URL(databaseUrl).pathname.replace(/^\//, '') !== disposableDatabase) {
  throw new Error(
    `IDENTITY_SEED_TEST_DATABASE_URL debe apuntar a la base desechable ${disposableDatabase}`,
  );
}
const syntheticEmail = 'seed-idempotency@spectra.test';
const firstPassword = 'first-disposable-password-2026';
const secondPassword = 'second-disposable-password-2026';

describe.skipIf(!databaseUrl)('identity seed against disposable PostgreSQL', () => {
  // Con la suite omitida no se conecta: el cliente perezoso solo abre conexión en la primera consulta.
  const prisma = databaseUrl
    ? new PrismaClient({ datasourceUrl: databaseUrl })
    : new PrismaClient();

  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { emailNormalized: syntheticEmail } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { emailNormalized: syntheticEmail } });
    await prisma.$disconnect();
  });

  it('runs twice without duplicate roles/users or changing the existing ADMIN hash', async () => {
    await seedIdentity(prisma, { email: syntheticEmail, password: firstPassword });
    const first = await prisma.user.findUniqueOrThrow({
      where: { emailNormalized: syntheticEmail },
    });

    await seedIdentity(prisma, { email: syntheticEmail, password: secondPassword });
    const second = await prisma.user.findUniqueOrThrow({
      where: { emailNormalized: syntheticEmail },
    });

    const roles = await prisma.role.groupBy({
      by: ['code'],
      where: { code: { in: ['CLIENTE', 'ADMIN'] } },
      _count: { _all: true },
    });
    expect(Object.fromEntries(roles.map((role) => [role.code, role._count._all]))).toEqual({
      ADMIN: 1,
      CLIENTE: 1,
    });
    expect(await prisma.user.count({ where: { emailNormalized: syntheticEmail } })).toBe(1);
    expect(second.passwordHash).toBe(first.passwordHash);
    expect(await argon2.verify(second.passwordHash, firstPassword)).toBe(true);
    expect(await argon2.verify(second.passwordHash, secondPassword)).toBe(false);
  }, 30_000);
});
