import { PrismaClient } from '@prisma/client';

/**
 * DT-09: cliente exclusivo de preparación y limpieza de datos en las pruebas.
 *
 * La aplicación bajo prueba usa `DATABASE_URL` (rol de ejecución, sin DELETE ni DDL). Los fixtures
 * usan `CATALOG_FIXTURE_DATABASE_URL` (rol migrador del esquema) para no ampliar los permisos del
 * runtime. Sin roles separados (p. ej. el job `quality` del CI) se reutiliza la URL de la aplicación.
 */
export function createFixtureClient(): PrismaClient {
  const datasourceUrl = process.env.CATALOG_FIXTURE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!datasourceUrl) throw new Error('DATABASE_URL no definido para los fixtures');
  return new PrismaClient({ datasourceUrl });
}
