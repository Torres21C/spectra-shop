import { PrismaClient } from '../generated/commerce-client/index.js';

/**
 * DT-09: cliente exclusivo de preparación y limpieza de datos en las pruebas.
 *
 * La aplicación bajo prueba usa `COMMERCE_DATABASE_URL` (rol de ejecución, sin DDL y con DELETE solo
 * en `cart_items`). Los fixtures (limpiezas, pedidos sintéticos y triggers de fallo) usan
 * `COMMERCE_FIXTURE_DATABASE_URL` (rol migrador del esquema) para no ampliar los permisos del
 * runtime. Sin roles separados se reutiliza la URL de la aplicación.
 */
export function createFixtureClient(): PrismaClient {
  const datasourceUrl =
    process.env.COMMERCE_FIXTURE_DATABASE_URL ?? process.env.COMMERCE_DATABASE_URL;
  if (!datasourceUrl) throw new Error('COMMERCE_DATABASE_URL no definido para los fixtures');
  return new PrismaClient({ datasourceUrl });
}
