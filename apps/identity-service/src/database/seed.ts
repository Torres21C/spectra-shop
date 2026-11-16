import argon2 from 'argon2';
import { PrismaClient } from '../generated/identity-client/index.js';

const prisma = new PrismaClient();

async function seed(): Promise<void> {
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

  const email = process.env.SYNTHETIC_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SYNTHETIC_ADMIN_PASSWORD;
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

try {
  await seed();
} finally {
  await prisma.$disconnect();
}
