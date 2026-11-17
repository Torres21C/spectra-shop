import { PrismaClient } from '../generated/audit-client/index.js';

/** DT-09: limpieza de pruebas con el rol migrador; la aplicación usa el rol de ejecución (INSERT/SELECT). */
export function createFixtureClient(): PrismaClient {
  const datasourceUrl = process.env.AUDIT_FIXTURE_DATABASE_URL ?? process.env.AUDIT_DATABASE_URL;
  if (!datasourceUrl) throw new Error('AUDIT_DATABASE_URL no definido para los fixtures');
  return new PrismaClient({ datasourceUrl });
}
