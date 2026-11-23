import { PrismaClient } from '../generated/identity-client/index.js';
import { seedIdentity } from './identity-seed.js';

const prisma = new PrismaClient();

try {
  await seedIdentity(prisma, {
    email: process.env.SYNTHETIC_ADMIN_EMAIL,
    password: process.env.SYNTHETIC_ADMIN_PASSWORD,
  });
} finally {
  await prisma.$disconnect();
}
