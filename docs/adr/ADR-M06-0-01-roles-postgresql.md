# ADR-M06-0-01 — Roles PostgreSQL de migración y de ejecución por servicio (DT-09)

- **Estado:** D-M06-0-01 a D-M06-0-04 corresponden al diseño aprobado por el propietario del proyecto al autorizar M06.0 (2026-11-16). D-M06-0-05 y D-M06-0-06 surgieron durante la implementación y el propietario las registró el 2026-11-16: D-M06-0-05 como decisión de diseño y D-M06-0-06 como **aceptación provisional para desarrollo**, con los límites de producción pendientes de definir.
- **Deuda:** DT-09 (roles PostgreSQL separados por servicio), previa a M06.
- **Riesgos y controles relacionados:** R26 (separación de esquemas `catalog`/`commerce` sin aislamiento efectivo) y privilegio mínimo en la capa de datos. Este ADR no modifica la matriz de riesgos ni de controles; su reevaluación corresponde a la revisión académica.
- **Runbook:** [dt09-roles-postgresql.md](../runbooks/dt09-roles-postgresql.md).

## Contexto

Hasta M05, Identity, Catalog y Commerce se conectaban con la misma credencial (`POSTGRES_USER`, un rol SUPERUSER propietario de todo) y cada contenedor ejecutaba `prisma migrate deploy` y sus seeds al arrancar. La separación en esquemas `identity`, `catalog` y `commerce` no aislaba nada: cualquier servicio comprometido podía leer o modificar los datos de los otros, ejecutar DDL o administrar el clúster. El inventario previo está en `EV-M06-0-BASELINE-LOCAL-20261116`.

## Decisiones

1. **D-M06-0-01. Dos roles por servicio.** `spectra_<servicio>_migrator` es el propietario del esquema y de todos sus objetos, incluida `_prisma_migrations`. `spectra_<servicio>_app` es el rol de ejecución. Los seis roles son `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, sin pertenencias entre sí, con solo `CONNECT` sobre la base y sin acceso a esquemas ajenos.
2. **D-M06-0-02. Matriz explícita de ejecución, propiedad del servicio.** `apps/<servicio>/prisma/runtime-grants.sql` revoca todo y concede exactamente las operaciones que usa el código:
   - **Identity:** `SELECT` en `roles`; `SELECT/INSERT/UPDATE` en `users`, `auth_sessions` y `refresh_tokens`; `SELECT/INSERT` en `outbox_events`.
   - **Catalog:** `SELECT` en `categories` y `products`; `UPDATE` solo de las columnas `stock` y `updated_at` de `products`; `SELECT/INSERT/UPDATE` en `stock_reservations`; `SELECT/INSERT` en `stock_reservation_lines`.
   - **Commerce:** `SELECT/INSERT/UPDATE` en `carts` y `checkout_attempts`; además `DELETE` solo en `cart_items`; `SELECT/INSERT` en `orders`, `order_items` y `outbox_events`; `USAGE` en `order_number_seq`.

   Lo aplica el migrador tras sus migraciones (`prisma db execute`). Ningún rol de ejecución tiene DDL, `TRUNCATE`, acceso a `_prisma_migrations`, tablas temporales ni `DEFAULT PRIVILEGES` que le concedan permisos futuros. Una migración que necesite más permisos (p. ej. la administración de M06) debe ampliar este archivo y la matriz de `scripts/verify-db-isolation.mjs` en el mismo cambio.

3. **D-M06-0-03. Migración, seed y ejecución separados.** Los Dockerfiles solo arrancan la aplicación. La secuencia de Compose es `postgres` → `postgres-provision` → `*-migrate` → `postgres-finalize` → servicios. Las credenciales llegan por variables de entorno no versionadas; el aprovisionamiento las lee con `\getenv` y desactiva el registro de sentencias de su sesión.
4. **D-M06-0-04. Fixtures de prueba sin ampliar el runtime.** Las suites de integración ejecutan la aplicación con el rol de ejecución y preparan o limpian datos con un cliente aparte conectado como migrador (`*_FIXTURE_DATABASE_URL`, `CATALOG_TEST_DATABASE_URL`, `IDENTITY_TEST_DATABASE_URL`). Sin roles separados (job `quality` del CI) se reutiliza la URL de la aplicación.
5. **D-M06-0-05 (registrada por el propietario, 2026-11-16). `CREATE SCHEMA` solo durante la migración, con revocación y verificación posterior.** Las migraciones ya aplicadas `20261114090000_m01_catalog` y `20261116110000_m03_cart` ejecutan `CREATE SCHEMA IF NOT EXISTS`. PostgreSQL comprueba `CREATE` sobre la base antes de evaluar `IF NOT EXISTS`, así que en un volumen nuevo fallaban con `42501` (comprobado en la primera ejecución). Se descartó editar migraciones aplicadas, porque alteraría su historial y sus checksums. `postgres-provision` concede `CREATE` sobre la base a los tres migradores y `postgres-finalize` lo revoca antes de que arranque cualquier servicio; además falla si algún rol de servicio conserva `CREATE` o `TEMP`. En reposo, la matriz es la aprobada. Mientras la ventana está abierta, un migrador podría crear un esquema nuevo de su propiedad, pero no acceder a los ajenos. Un redespliegue sin migraciones pendientes funciona con la ventana cerrada (comprobado).
6. **D-M06-0-06 (aceptada provisionalmente para desarrollo, 2026-11-16). Sin límite de conexiones por rol; los límites de producción quedan pendientes de definir.** Una primera versión fijaba `CONNECTION LIMIT` (5 migradores, 40 runtime). Hizo fallar la prueba de concurrencia RNF-REN-02, cuyos fixtures abren más de cinco conexiones como migrador. Como el plan no incluía límites por rol y un valor mal dimensionado causaría indisponibilidad, se dejan en `-1`; el límite global sigue siendo `max_connections`.

## Consecuencias

- La separación por esquemas pasa a ser efectiva: el verificador comprueba 322 condiciones, entre ellas la matriz exacta de tabla y columna, las pruebas negativas reales de DDL, `TRUNCATE`, esquemas ajenos, TEMP, `public`, `SET ROLE` y `pg_authid`, y PUBLIC. Lo hace en volumen nuevo y en una copia restaurada del volumen existente.
- Los despliegues necesitan seis secretos adicionales.
- Desde el endurecimiento final de M06.0, el seed de Catalog solo inserta las filas que faltan y nunca sobrescribe productos existentes (D-M06-0-13 en ADR-M06-0-02). Antes restablecía stock y precios en cada despliegue.
- El rollback (`infra/postgres/rollback-service-roles.sql`) devuelve la propiedad al administrador y elimina los roles sin tocar datos.
