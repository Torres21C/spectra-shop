import { PrismaClient } from '@prisma/client';
import { seedCatalog } from './catalog-seed.js';

const prisma = new PrismaClient();

try {
  const result = await seedCatalog(prisma);
  // Solo conteos: el seed no imprime datos ni credenciales.
  process.stdout.write(`${JSON.stringify({ event: 'catalog_seed', ...result })}\n`);
} finally {
  await prisma.$disconnect();
}
