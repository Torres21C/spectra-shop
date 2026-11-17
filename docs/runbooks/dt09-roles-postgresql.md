# Runbook DT-09 — Roles PostgreSQL por servicio (M06.0)

Este procedimiento aplica, verifica y revierte la separación de credenciales PostgreSQL de M06.0. Decisión: [ADR-M06-0-01](../adr/ADR-M06-0-01-roles-postgresql.md).

## Modelo

| Servicio | Rol de migración (propietario del esquema) | Rol de ejecución       |
| -------- | ------------------------------------------ | ---------------------- |
| Identity | `spectra_identity_migrator`                | `spectra_identity_app` |
| Catalog  | `spectra_catalog_migrator`                 | `spectra_catalog_app`  |
| Commerce | `spectra_commerce_migrator`                | `spectra_commerce_app` |

- `POSTGRES_USER` es el administrador del clúster. Solo lo usan el contenedor `postgres`, `postgres-provision` y `postgres-finalize`; ningún servicio se conecta con él.
- Los seis roles son `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, sin pertenencias entre sí y con solo `CONNECT` sobre la base.
- Cada migrador es propietario de su esquema y de todos sus objetos, incluida `_prisma_migrations`, y no tiene acceso a los otros esquemas.
- Cada rol de ejecución tiene `USAGE` sobre su esquema y la matriz de `apps/<servicio>/prisma/runtime-grants.sql`. No tiene DDL, `TRUNCATE`, acceso a `_prisma_migrations`, tablas temporales ni acceso a otros esquemas.

## Orden de arranque (Compose)

```text
postgres (healthy)
  └─ postgres-provision        roles, CONNECT, propiedad, revocaciones y apertura de la ventana de migración
       ├─ identity-migrate     migrate deploy + runtime-grants.sql + seed     (rol migrador)
       ├─ catalog-migrate      migrate deploy + runtime-grants.sql + seed     (rol migrador)
       └─ commerce-migrate     migrate deploy + runtime-grants.sql            (rol migrador)
            └─ postgres-finalize   cierra la ventana: revoca CREATE sobre la base a los migradores
                 └─ identity-service / catalog-service / commerce-service (rol de ejecución)
```

Los Dockerfiles de los servicios ya no migran ni siembran al arrancar.

**Ventana de migración.** Las migraciones históricas M01 (Catalog) y M03 (Commerce) contienen `CREATE SCHEMA IF NOT EXISTS`. PostgreSQL exige `CREATE` sobre la base antes de comprobar si el esquema existe, de modo que los migradores reciben ese privilegio solo entre `postgres-provision` y `postgres-finalize`. En reposo nadie lo conserva, y `postgres-finalize` falla si algún rol de servicio mantiene `CREATE` o `TEMP`.

## Credenciales

Genere seis valores distintos fuera del repositorio y cópielos solo en `.env`:

```bash
for role in IDENTITY_MIGRATOR IDENTITY_APP CATALOG_MIGRATOR CATALOG_APP COMMERCE_MIGRATOR COMMERCE_APP; do
  echo "SPECTRA_${role}_PASSWORD=$(openssl rand -hex 32)"
done >> .env   # .env está en .gitignore; no imprima ni registre estos valores
```

El aprovisionamiento rechaza valores que no sean hexadecimales de 32 a 128 caracteres o que se repitan. Lee las contraseñas con `\getenv`, de modo que no aparecen en argumentos de proceso, y desactiva el registro de sentencias de su sesión para que no lleguen al log del servidor. Para rotar una contraseña, cambie el valor en `.env` y vuelva a ejecutar `postgres-provision` y el servicio afectado.

## Volumen nuevo

```bash
docker compose up --build
docker compose --profile test run --rm db-isolation-test   # matriz de privilegios: debe terminar con failed=0
```

## Volumen existente (con datos)

> En la base real de desarrollo, este procedimiento requiere la autorización expresa del propietario del proyecto. Debe probarse antes sobre una copia restaurada.

1. **Respaldo verificado.** `pg_dump -Fc` y `pg_dumpall --globals-only` en almacenamiento privado (directorio 700, archivos 600), con SHA-256 y una restauración completa comprobada en un contenedor desechable (filas, hash de contenido, propietarios). No continúe si la restauración falla.
2. **Inventario previo.** Propietarios, ACL, `DEFAULT PRIVILEGES` y conteos por tabla (consulta en `BEGIN TRANSACTION READ ONLY`).
3. **Detener los servicios** sin tocar el volumen: `docker compose stop web commerce-service catalog-service identity-service`.
4. **Aprovisionar y migrar** con la nueva configuración: `docker compose up -d --build identity-service catalog-service commerce-service web`. `postgres-provision` transfiere la propiedad del contenido actual a los migradores; los jobs `*-migrate` no encuentran migraciones pendientes y solo aplican `runtime-grants.sql` y los seeds; `postgres-finalize` cierra la ventana.
5. **Verificar.**
   - `docker compose --profile test run --rm db-isolation-test` debe terminar con `failed=0`.
   - Los conteos y hashes de contenido deben ser idénticos a los del inventario previo. Solo cambian propietarios, ACL y `_prisma_migrations` si había migraciones pendientes. Los seeds solo insertan filas que falten: no modifican stock, precios ni productos existentes.
   - Revise la salud de los servicios y haga un recorrido de catálogo, login, carrito y pedidos.

## Rollback

Úselo si un servicio no arranca o falta un permiso que no pueda corregirse de inmediato en `runtime-grants.sql`.

1. Detenga los servicios: `docker compose stop web commerce-service catalog-service identity-service`.
2. Vuelva a una configuración en la que los servicios se conecten con `POSTGRES_USER`, por ejemplo `git checkout <commit-anterior> -- compose.yaml apps/*/Dockerfile`.
3. Devuelva la propiedad y elimine los roles (no modifica datos):

   ```bash
   docker compose exec -T -e SPECTRA_ROLLBACK_OWNER="$POSTGRES_USER" postgres \
     sh -c 'psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f -' \
     < infra/postgres/rollback-service-roles.sql
   ```

4. Arranque los servicios con la configuración anterior y compruebe su salud.
5. Último recurso: restaure el respaldo del paso 1 en una base nueva (`globals.sql`, `createdb -O`, `pg_restore --exit-on-error`) y compare filas y hashes antes de reemplazar nada.

El rollback restablece la propiedad (`spectra_app`) y los privilegios efectivos de PUBLIC (`CONNECT`, `TEMP`). Algunas ACL pueden quedar escritas de forma explícita en lugar de `NULL`, con un efecto equivalente; está documentado en la evidencia DT-09.

## Ampliar permisos

Una migración que añada tablas, columnas que el servicio deba modificar u operaciones nuevas (por ejemplo, la administración de M06) debe ampliar `runtime-grants.sql` del mismo servicio en el mismo cambio, y `scripts/verify-db-isolation.mjs` con la matriz esperada. El verificador falla si aparece una tabla no cubierta por la matriz.
