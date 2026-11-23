import argon2 from 'argon2';
import type { PrismaClient } from '../generated/identity-client/index.js';

export interface SyntheticAdminSeed {
  email?: string | undefined;
  password?: string | undefined;
}

/**
 * Datos mínimos y sintéticos de Identity. Es idempotente: normaliza los dos roles conocidos y solo crea
 * el ADMIN si no existe; nunca sustituye su contraseña ni otros atributos en ejecuciones posteriores.
 */
export async function seedIdentity(
  prisma: PrismaClient,
  syntheticAdmin: SyntheticAdminSeed = {},
): Promise<void> {
  await prisma.role.upsert({
    where: { code: 'CLIENTE' },
    create: { id: '10000000-0000-4000-8000-000000000001', code: 'CLIENTE', name: 'Cliente' },
    update: { name: 'Cliente' },
  });
  const adminRole = await prisma.role.upsert({
    where: { code: 'ADMIN' },
    create: {
      id: '10000000-0000-4000-8000-000000000002',
      code: 'ADMIN',
      name: 'Administrador',
    },
    update: { name: 'Administrador' },
  });

  const email = syntheticAdmin.email?.trim().toLowerCase();
  const password = syntheticAdmin.password;
  if (!email && !password) return;
  if (!email || !password || password.length < 16) {
    throw new Error('El seed ADMIN requiere correo y contraseña de al menos 16 caracteres');
  }
  await prisma.user.upsert({
    where: { emailNormalized: email },
    create: {
      fullName: 'Administrador sintético',
      emailNormalized: email,
      passwordHash: await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
      }),
      roleId: adminRole.id,
    },
    update: {},
  });
}
