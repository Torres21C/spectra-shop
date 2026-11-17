import { Prisma, type PrismaClient } from '@prisma/client';
import { normalizeSearchText } from '../catalog/catalog.helpers.js';

// Datos sintéticos de demostración del catálogo (M01).
export const CATALOG_SEED_CATEGORIES = [
  { id: '10000000-0000-4000-8000-000000000001', slug: 'audio', name: 'Audio' },
  { id: '10000000-0000-4000-8000-000000000002', slug: 'perifericos', name: 'Periféricos' },
  { id: '10000000-0000-4000-8000-000000000003', slug: 'productividad', name: 'Productividad' },
] as const;

export const CATALOG_SEED_PRODUCTS = [
  {
    id: '20000000-0000-4000-8000-000000000001',
    categoryId: CATALOG_SEED_CATEGORIES[1].id,
    sku: 'SP-KEY-001',
    name: 'Teclado mecánico Nova',
    description: 'Teclado mecánico compacto con iluminación blanca y distribución en español.',
    price: '649.00',
    stock: 12,
    imageKey: 'keyboard',
    isActive: true,
  },
  {
    id: '20000000-0000-4000-8000-000000000002',
    categoryId: CATALOG_SEED_CATEGORIES[1].id,
    sku: 'SP-KEY-002',
    name: 'Teclado compacto Orbit',
    description: 'Teclado inalámbrico de perfil bajo para espacios de trabajo pequeños.',
    price: '389.90',
    stock: 4,
    imageKey: 'keyboard-compact',
    isActive: true,
  },
  {
    id: '20000000-0000-4000-8000-000000000003',
    categoryId: CATALOG_SEED_CATEGORIES[0].id,
    sku: 'SP-AUD-001',
    name: 'Audífonos Nebula',
    description: 'Audífonos circumaurales con micrófono desmontable y sonido envolvente.',
    price: '799.00',
    stock: 0,
    imageKey: 'headphones',
    isActive: true,
  },
  {
    id: '20000000-0000-4000-8000-000000000004',
    categoryId: CATALOG_SEED_CATEGORIES[0].id,
    sku: 'SP-AUD-002',
    name: 'Bocina Pulse Mini',
    description: 'Bocina portátil con conexión Bluetooth y autonomía de doce horas.',
    price: '459.50',
    stock: 9,
    imageKey: 'speaker',
    isActive: true,
  },
  {
    id: '20000000-0000-4000-8000-000000000005',
    categoryId: CATALOG_SEED_CATEGORIES[1].id,
    sku: 'SP-MOU-001',
    name: 'Mouse Vector',
    description: 'Mouse ergonómico con sensor óptico y seis botones configurables.',
    price: '279.00',
    stock: 5,
    imageKey: 'mouse',
    isActive: true,
  },
  {
    id: '20000000-0000-4000-8000-000000000006',
    categoryId: CATALOG_SEED_CATEGORIES[2].id,
    sku: 'SP-HUB-001',
    name: 'Hub USB-C Prisma',
    description: 'Adaptador multipuerto con HDMI, USB 3.0 y lector de tarjetas.',
    price: '529.00',
    stock: 18,
    imageKey: 'hub',
    isActive: true,
  },
  {
    id: '20000000-0000-4000-8000-000000000007',
    categoryId: CATALOG_SEED_CATEGORIES[2].id,
    sku: 'SP-STD-001',
    name: 'Soporte Atlas',
    description: 'Soporte ajustable de aluminio para computadora portátil.',
    price: '319.00',
    stock: 3,
    imageKey: 'stand',
    isActive: true,
  },
  {
    id: '20000000-0000-4000-8000-000000000008',
    categoryId: CATALOG_SEED_CATEGORIES[0].id,
    sku: 'SP-MIC-001',
    name: 'Micrófono Quasar',
    description: 'Micrófono USB cardioide para videollamadas y contenido digital.',
    price: '689.00',
    stock: 7,
    imageKey: 'microphone',
    isActive: true,
  },
  {
    id: '20000000-0000-4000-8000-000000000009',
    categoryId: CATALOG_SEED_CATEGORIES[2].id,
    sku: 'SP-LGT-001',
    name: 'Lámpara Halo',
    description: 'Lámpara de escritorio regulable con puerto de carga USB-C.',
    price: '249.00',
    stock: 11,
    imageKey: 'lamp',
    isActive: true,
  },
  {
    id: '20000000-0000-4000-8000-000000000010',
    categoryId: CATALOG_SEED_CATEGORIES[1].id,
    sku: 'SP-PAD-001',
    name: 'Mousepad Eclipse',
    description: 'Superficie amplia de tejido técnico con base antideslizante.',
    price: '149.00',
    stock: 22,
    imageKey: 'mousepad',
    isActive: true,
  },
  {
    id: '20000000-0000-4000-8000-000000000011',
    categoryId: CATALOG_SEED_CATEGORIES[0].id,
    sku: 'SP-AUD-003',
    name: 'Audífonos Comet',
    description: 'Audífonos ligeros con conexión USB-C y controles integrados.',
    price: '299.00',
    stock: 14,
    imageKey: 'earbuds',
    isActive: true,
  },
  {
    id: '20000000-0000-4000-8000-000000000012',
    categoryId: CATALOG_SEED_CATEGORIES[2].id,
    sku: 'SP-CAM-001',
    name: 'Cámara Zenith',
    description: 'Cámara web Full HD con obturador físico de privacidad.',
    price: '579.00',
    stock: 6,
    imageKey: 'camera',
    isActive: true,
  },
  {
    id: '20000000-0000-4000-8000-000000000013',
    categoryId: CATALOG_SEED_CATEGORIES[2].id,
    sku: 'SP-CBL-001',
    name: 'Cable Flux USB-C',
    description: 'Cable trenzado USB-C de dos metros para carga y transferencia de datos.',
    price: '119.00',
    stock: 16,
    imageKey: 'cable',
    isActive: true,
  },
  {
    id: '20000000-0000-4000-8000-000000000014',
    categoryId: CATALOG_SEED_CATEGORIES[1].id,
    sku: 'SP-KEY-LEGACY',
    name: 'Teclado Legacy',
    description: 'Producto sintético inactivo para verificar el borrado lógico.',
    price: '199.00',
    stock: 30,
    imageKey: 'keyboard',
    isActive: false,
  },
  {
    id: '20000000-0000-4000-8000-000000000015',
    categoryId: CATALOG_SEED_CATEGORIES[2].id,
    sku: 'SP-ORG-001',
    name: 'Organizador Lumen',
    description: 'Organizador modular de escritorio usado en las pruebas sintéticas de carrito.',
    price: '325.00',
    stock: 10,
    imageKey: 'organizer',
    isActive: true,
  },
] as const;

/**
 * Siembra idempotente del catálogo (M06.0). Solo **inserta** las categorías y productos que faltan
 * (`INSERT … ON CONFLICT DO NOTHING`); nunca actualiza filas existentes. Así un despliegue no
 * sobrescribe el stock descontado por pedidos confirmados, ni precios, nombres o estados modificados.
 * Antes de M06.0 el seed hacía `upsert` con `update` completo y restablecía el stock en cada arranque.
 */
export async function seedCatalog(
  prisma: PrismaClient,
): Promise<{ categoriesCreated: number; productsCreated: number }> {
  const categories = await prisma.category.createMany({
    data: CATALOG_SEED_CATEGORIES.map((category) => ({ ...category })),
    skipDuplicates: true,
  });
  const products = await prisma.product.createMany({
    data: CATALOG_SEED_PRODUCTS.map((product) => ({
      ...product,
      price: new Prisma.Decimal(product.price),
      searchText: normalizeSearchText(`${product.name} ${product.description}`),
    })),
    skipDuplicates: true,
  });
  return { categoriesCreated: categories.count, productsCreated: products.count };
}
