# Guía de operación local — SPECTRA Shop

- **Versión de referencia:** `main` = `2a27350` (merge del PR #11, M06/M07 mínimos), revisada el 2026-11-20.
- **Público:** cualquier integrante que necesite levantar, operar o diagnosticar SPECTRA Shop en su equipo.
- **Alcance:** entorno local con Docker Compose. No describe AWS (ver [04-plan-despliegue-aws.md](04-plan-despliegue-aws.md)).

> [!WARNING]
> **Las suites de integración (`identity-test`, `catalog-test`, `commerce-test`, `audit-test`) BORRAN usuarios y datos de la base a la que se conectan.** `identity-test` elimina todos los usuarios, incluido el ADMIN sintético. Nunca las ejecute en el proyecto Compose principal (`spectra-shop`): use siempre un proyecto desechable con `-p` (sección 18).

## Convenciones de esta guía

- Todos los comandos se ejecutan **desde la raíz del repositorio** (`spectra-shop/`), salvo que se indique otro directorio.
- Etiquetas de riesgo:
  - 🟢 **SOLO LECTURA**: no modifica datos ni contenedores.
  - 🟡 **MODIFICA**: cambia datos, esquemas o el estado de los contenedores, pero es recuperable.
  - 🔴 **PELIGROSO**: puede destruir datos de forma irreversible. Requiere autorización del propietario del proyecto.
- **Stack principal:** proyecto Compose `spectra-shop` con el volumen persistente `spectra-shop_postgres-data`. Contiene los datos de desarrollo.
- **Stack desechable:** cualquier proyecto Compose con otro nombre (`-p spectra-aislado`) y su propio volumen. Es el único lugar donde se ejecutan pruebas de integración o escrituras masivas.

---

## 1. Requisitos del equipo

| Requisito                                           | Versión                                           | Comprobación 🟢                            |
| --------------------------------------------------- | ------------------------------------------------- | ------------------------------------------ |
| Docker Desktop (o Docker Engine) con Compose v2.24+ | Validado con Compose v5.5.1                       | `docker compose version`                   |
| Node.js                                             | 22 LTS o 24 (`engines: >=22 <25`)                 | `node --version`                           |
| npm                                                 | 10+ (el repo fija `npm@11.19.0`)                  | `npm --version`                            |
| OpenSSL                                             | Cualquiera reciente                               | `openssl version`                          |
| Memoria libre para Docker                           | ≥ 4 GB recomendado (5 imágenes Node + PostgreSQL) | Docker Desktop → Settings → Resources      |
| Postman Desktop (opcional)                          | Reciente                                          | Ver [postman/README.md](postman/README.md) |

No hace falta instalar PostgreSQL en el equipo: `psql` y `pg_dump` se ejecutan dentro del contenedor `postgres`.

## 2. Estructura del proyecto

```text
spectra-shop/
├── apps/
│   ├── web/                 React 19 + Vite 8 (SPA con rutas hash #/…); puerto 5173
│   ├── identity-service/    NestJS: registro, login, sesiones, JWT ES256      3001 público, 3101 interno
│   ├── catalog-service/     NestJS: catálogo, inventario, alta ADMIN, relay   3002 público, 3102 interno
│   ├── commerce-service/    NestJS: carrito, checkout (saga), pedidos         3003 público
│   └── audit-service/       NestJS: auditoría append-only                      3004 público, 3104 interno
├── packages/contracts/      Tipos de transporte compartidos (sin lógica)
├── infra/postgres/          SQL de aprovisionamiento DT-09 (provision, finalize, rollback)
├── scripts/                 verify-db-isolation.mjs (DT-09) y mvp-e2e-smoke.mjs (E2E por HTTP)
├── compose.yaml             Stack local completo + perfil `test`
├── .env.example             Plantilla de variables (copiar a .env, nunca versionar .env)
├── docs/                    ADR, runbooks, cierre operativo y esta carpeta
└── .github/workflows/ci.yml Calidad, Gitleaks, Semgrep, SCA/SBOM
```

Cada servicio tiene su esquema PostgreSQL (`identity`, `catalog`, `commerce`, `audit`) dentro de una única base `spectra_shop`, con dos roles por servicio (migrador y ejecución). Ver [ADR-M06-0-01](../adr/ADR-M06-0-01-roles-postgresql.md).

## 3. Configurar `.env` desde `.env.example`

🟡 Crea archivos locales con secretos. Hágalo una sola vez; **no** sobrescriba un `.env` existente.

```bash
# Raíz del repo. Abortará si .env ya existe (no lo sobrescribe).
test -e .env && echo "Ya existe .env: no lo sobrescriba" || (umask 077 && cp .env.example .env)
```

Rellene cada variable con valores generados fuera del repositorio. El bloque siguiente **no imprime** los valores; los escribe directamente en `.env` (permisos 600) y en un directorio privado de claves:

```bash
# Raíz del repo. Solo para un .env recién copiado de .env.example.
umask 077
KEYS_DIR="$HOME/.config/spectra-shop/dev-keys"   # fuera del repositorio
mkdir -p "$KEYS_DIR"
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$KEYS_DIR/private.pem"
openssl pkey -in "$KEYS_DIR/private.pem" -pubout -out "$KEYS_DIR/public.pem"
chmod 644 "$KEYS_DIR/public.pem"
# En Linux el contenedor corre como UID 1000 (usuario node): sudo chown 1000:1000 "$KEYS_DIR"/*.pem

set_env() { # sustituye la línea VAR=… de .env sin mostrar el valor
  local key="$1" value="$2"
  /usr/bin/sed -i.bak "s|^${key}=.*|${key}=${value}|" .env && rm -f .env.bak
}
set_env POSTGRES_PASSWORD "$(openssl rand -hex 32)"
for r in IDENTITY_MIGRATOR IDENTITY_APP CATALOG_MIGRATOR CATALOG_APP \
         COMMERCE_MIGRATOR COMMERCE_APP AUDIT_MIGRATOR AUDIT_APP; do
  set_env "SPECTRA_${r}_PASSWORD" "$(openssl rand -hex 32)"
done
INTERNAL="$(openssl rand -hex 32)"; INVENTORY="$(openssl rand -hex 32)"
set_env SPECTRA_INTERNAL_TOKEN "$INTERNAL";  set_env SPECTRA_INTERNAL_TOKENS "$INTERNAL"
set_env CATALOG_INVENTORY_TOKEN "$INVENTORY"; set_env CATALOG_INVENTORY_TOKENS "$INVENTORY"
set_env SPECTRA_KEYS_DIR "$KEYS_DIR"
unset INTERNAL INVENTORY
chmod 600 .env
```

Reglas que aplica el código (si no se cumplen, el job o el servicio fallan al arrancar):

| Variable                                                          | Regla                                                                                                                      |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `SPECTRA_*_MIGRATOR_PASSWORD`, `SPECTRA_*_APP_PASSWORD` (8)       | Hexadecimal de 32–128 caracteres y **todas distintas** (lo valida `postgres-provision`).                                   |
| `SPECTRA_INTERNAL_TOKEN` / `SPECTRA_INTERNAL_TOKENS`              | ≥ 32 caracteres. `…TOKENS` admite el actual y el anterior separados por coma durante una rotación.                         |
| `CATALOG_INVENTORY_TOKEN(S)`                                      | ≥ 32 caracteres y **distinto** del token interno compartido.                                                               |
| `SPECTRA_KEYS_DIR`                                                | Ruta absoluta fuera del repo con `private.pem` y `public.pem` (EC P-256).                                                  |
| `SYNTHETIC_ADMIN_EMAIL` / `SYNTHETIC_ADMIN_PASSWORD` (opcionales) | Si se definen, el seed crea un ADMIN sintético (solo inserta; nunca modifica uno existente). Contraseña de 16+ caracteres. |

> [!NOTE]
> `COOKIE_SECURE` e `IDENTITY_ALLOW_EPHEMERAL_KEYS` aparecen en `.env.example`, pero `compose.yaml` fija sus valores por servicio (`'false'`); cambiarlos en `.env` **no tiene efecto** en el stack Compose.

Comprobación 🟢 (lista solo los **nombres** de variables, nunca los valores):

```bash
grep -oE '^[A-Z_]+=' .env | tr -d '=' | sort
docker compose config --quiet && echo "compose.yaml + .env: OK"
```

> [!CAUTION]
> No use `docker compose config` sin `--quiet`, `--services` o `--volumes`: imprime la configuración **con las contraseñas interpoladas**.

## 4. Iniciar solo PostgreSQL

🟡 Crea o arranca el contenedor; el volumen persiste.

```bash
docker compose up -d --wait postgres
```

PostgreSQL **no publica puertos al host**: solo existe en la red interna `backend`. Esto no aplica migraciones ni crea roles; para eso hace falta la cadena completa (sección 6).

## 5. Verificar la base de datos

🟢 Todos los comandos de esta sección abren la sesión en modo **solo lectura** (`default_transaction_read_only=on`).

```bash
# Alias de conveniencia para esta terminal (sesión de solo lectura como administrador del clúster).
psql_ro() {
  docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres \
    sh -c 'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' -- "$@"
}

psql_ro -c 'SELECT version();'
psql_ro -c '\dn+'                                  # esquemas y propietarios
psql_ro -c '\du'                                   # roles (deben aparecer los 8 spectra_*_migrator/app)
psql_ro -c '\dt identity.*' -c '\dt catalog.*' -c '\dt commerce.*' -c '\dt audit.*'
docker compose exec postgres pg_isready            # estado del servidor
```

## 6. Cómo se aprovisionan roles y esquemas (DT-09)

Cada `docker compose up` ejecuta esta cadena antes de arrancar cualquier servicio:

```text
postgres (healthy)
  └─ postgres-provision    infra/postgres/provision-service-roles.sql (como POSTGRES_USER)
       │                   crea/actualiza 8 roles LOGIN sin privilegios especiales, transfiere la
       │                   propiedad de cada esquema a su migrador, revoca PUBLIC y abre la
       │                   «ventana de migración» (CREATE sobre la base solo para migradores)
       ├─ identity-migrate  prisma migrate deploy + prisma/runtime-grants.sql + seed (roles, ADMIN opcional)
       ├─ catalog-migrate   prisma migrate deploy + runtime-grants.sql + seed (3 categorías y 15 productos, 14 activos; solo inserta)
       ├─ commerce-migrate  prisma migrate deploy + runtime-grants.sql
       └─ audit-migrate     prisma migrate deploy + runtime-grants.sql
            └─ postgres-finalize   infra/postgres/finalize-service-roles.sql: cierra la ventana
                                   y falla si algún rol conserva CREATE o TEMP sobre la base
                 └─ identity-service, catalog-service, commerce-service, audit-service (rol *_app)
```

- `POSTGRES_USER` es solo el administrador del clúster; ningún servicio se conecta con él.
- Cada `*_app` tiene exactamente los permisos de `apps/<servicio>/prisma/runtime-grants.sql` (p. ej., audit: solo `INSERT`/`SELECT`).
- Todo el proceso es **idempotente**: repetirlo no borra datos. Las contraseñas de los roles se vuelven a fijar con los valores actuales de `.env`.
- Procedimiento completo, verificación y rollback: [runbook DT-09](../runbooks/dt09-roles-postgresql.md).

## 7. Cómo funcionan las migraciones Prisma

| Servicio | Migraciones en `main`                                                                                                                  | Rol que migra               | Esquema    |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ---------- |
| Identity | `20261114170000_m02_identity`                                                                                                          | `spectra_identity_migrator` | `identity` |
| Catalog  | `…m01_catalog`, `…m04_stock_reservations`, `…m06_0_reservation_states`, `…m06_0_inventory_delivery`, `20261120090000_m06_admin_outbox` | `spectra_catalog_migrator`  | `catalog`  |
| Commerce | `…m03_cart`, `…m04_checkout`, `…m04_1_saga_recovery`, `…m05_order_timeline`, `20261119092000_m06_0_fulfillment_recovery`               | `spectra_commerce_migrator` | `commerce` |
| Audit    | `20261120091000_m07_audit_events`                                                                                                      | `spectra_audit_migrator`    | `audit`    |

- Los jobs `*-migrate` ejecutan `prisma migrate deploy`: aplican **solo las migraciones pendientes**, en orden, y las registran en `<esquema>._prisma_migrations`. Nunca generan migraciones nuevas ni hacen `reset`.
- Los contenedores de los servicios **no migran** al arrancar (DT-09).
- 🟡 **Consecuencia operativa:** `docker compose up` sobre el stack principal aplica automáticamente cualquier migración pendiente tras un `git pull`. Haga un respaldo (sección 17) antes del primer `up` con código nuevo.

> [!IMPORTANT]
> Según la bitácora de M06/M07 (2026-11-17), la base principal se respaldó antes del merge del PR #11, pero **no** se le aplicaron las migraciones M06/M07 (`catalog.outbox_events`, esquema `audit`). El próximo `docker compose up` en el stack principal las aplicará. No pudo verificarse hoy porque Docker estaba detenido. Compruébelo con la consulta 🟢 siguiente antes de levantar todo.

Estado de migraciones 🟢:

```bash
psql_ro -c "SELECT 'identity' s, migration_name, finished_at FROM identity._prisma_migrations
            UNION ALL SELECT 'catalog', migration_name, finished_at FROM catalog._prisma_migrations
            UNION ALL SELECT 'commerce', migration_name, finished_at FROM commerce._prisma_migrations
            ORDER BY 1, 2;"
psql_ro -c "SELECT migration_name, finished_at FROM audit._prisma_migrations;"  # falla si audit aún no existe
```

## 8. Iniciar cada microservicio individualmente

🟡 Todos ejecutan la cadena de la sección 6 (aprovisionamiento + **las cuatro** migraciones), porque `postgres-finalize` depende de todos los jobs `*-migrate`.

| Objetivo | Comando                                                | Qué arranca además                                                                                                                                              |
| -------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity | `docker compose up -d --build --wait identity-service` | postgres, provision, 4 migraciones, finalize                                                                                                                    |
| Catalog  | `docker compose up -d --build --wait catalog-service`  | igual que Identity. La alta ADMIN necesita Identity en marcha (si no, 503 `IDENTITY_UNAVAILABLE`); el relay de auditoría reintenta con backoff si Audit no está |
| Commerce | `docker compose up -d --build --wait commerce-service` | también identity-service y catalog-service (dependencias `service_healthy`)                                                                                     |
| Audit    | `docker compose up -d --build --wait audit-service`    | cadena base. La consulta ADMIN necesita Identity                                                                                                                |

Para arrancar **solo** un contenedor ya construido sin tocar sus dependencias: `docker compose up -d --no-deps <servicio>` (útil tras `docker compose stop <servicio>`).

## 9. Iniciar toda la aplicación

🟡

```bash
docker compose up -d --build --wait
docker compose ps --all     # 🟢 servicios healthy y jobs «Exited (0)»
```

`--build` reconstruye las imágenes de los servicios (no las `*-test`). La primera vez tarda varios minutos.

## 10. Iniciar únicamente la Web

| Opción                                 | Comando                                                                  | Notas                                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contenedor (vite preview del build) 🟡 | `docker compose up -d --build --wait web`                                | Arranca también Identity, Catalog y Commerce (dependencias). **No** arranca Audit: la pantalla `#/admin/auditoria` falla hasta `docker compose up -d --wait audit-service`. |
| Solo el contenedor web 🟡              | `docker compose up -d --no-deps web`                                     | Carga la SPA; las llamadas a la API fallan si los backends no corren.                                                                                                       |
| Servidor de desarrollo de Vite 🟡      | `docker compose stop web` y luego `npm run dev --workspace @spectra/web` | Recarga en caliente en <http://127.0.0.1:5173>. Requiere `npm ci` previo y los backends en Docker.                                                                          |

Abra siempre **<http://127.0.0.1:5173>** (no `localhost`): la SPA llama a `http://127.0.0.1:300x` y las cookies son por host; mezclar `localhost` y `127.0.0.1` impide que viajen las cookies de sesión.

## 11. Puertos y URLs

| Componente | Host (publicado) | Interno (red Compose)                                      | URLs útiles                                                    |
| ---------- | ---------------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| Web        | `127.0.0.1:5173` | `web:5173`                                                 | <http://127.0.0.1:5173>                                        |
| Identity   | `127.0.0.1:3001` | `identity-service:3001` y **3101** (interno, no publicado) | `/health`, `/auth/csrf`, Swagger `/docs`, OpenAPI `/docs-json` |
| Catalog    | `127.0.0.1:3002` | `catalog-service:3002` y **3102** (interno)                | `/health`, `/products`, Swagger `/docs`                        |
| Commerce   | `127.0.0.1:3003` | `commerce-service:3003`                                    | `/health`, Swagger `/docs`                                     |
| Audit      | `127.0.0.1:3004` | `audit-service:3004` y **3104** (interno)                  | `/health` (sin Swagger)                                        |
| PostgreSQL | — (no publicado) | `postgres:5432`                                            | Solo vía `docker compose exec postgres …`                      |

Todos los puertos se publican solo en `127.0.0.1`. Los listeners internos (3101, 3102, 3104) exigen tokens de servicio y no son accesibles desde el host.

## 12. Ver los logs de cada servicio

🟢

```bash
docker compose logs -f --tail=200 identity-service      # catalog-service, commerce-service, audit-service, web, postgres
docker compose logs --no-log-prefix commerce-service | grep checkout_saga_metrics   # métricas de la saga
docker compose logs postgres-provision identity-migrate catalog-migrate commerce-migrate audit-migrate postgres-finalize
docker compose logs --since 10m catalog-service | grep audit_relay                 # relay de auditoría
```

Los servicios escriben JSON por `stdout` (Nest `Logger`). Toda respuesta HTTP lleva `X-Request-Id`; los errores 5xx y los eventos técnicos lo registran, lo que permite correlacionar una petición con su log: `docker compose logs | grep <X-Request-Id>`.

## 13. Consultar tablas y esquemas

🟢 Use la función `psql_ro` de la sección 5.

```bash
psql_ro -c '\d+ catalog.products'
psql_ro -c 'SELECT id, sku, name, price, stock, is_active FROM catalog.products ORDER BY sku;'
psql_ro -c 'SELECT order_number, status, total, created_at FROM commerce.orders ORDER BY created_at DESC LIMIT 10;'
psql_ro -c 'SELECT event_type, result, occurred_at, published_at FROM catalog.outbox_events ORDER BY occurred_at DESC LIMIT 10;'
psql_ro -c 'SELECT source_service, event_type, occurred_at FROM audit.audit_events ORDER BY occurred_at DESC LIMIT 10;'
psql_ro -c 'SELECT status, count(*) FROM catalog.stock_reservations GROUP BY status;'
```

Conteo exacto de todas las tablas de negocio (útil antes y después de cualquier operación):

```bash
docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres \
  sh -c 'psql -X -q -At -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT format('SELECT %L || ''|'' || count(*) FROM %I.%I', table_schema || '.' || table_name, table_schema, table_name)
  FROM information_schema.tables
 WHERE table_schema IN ('identity', 'catalog', 'commerce', 'audit') AND table_type = 'BASE TABLE'
 ORDER BY table_schema, table_name \gexec
SQL
```

No consulte `identity.users.password_hash`, `identity.refresh_tokens.token_hash` ni datos de entrega en capturas o evidencias.

## 14. Verificar health checks

🟢

```bash
for p in 3001 3002 3003 3004; do printf '%s ' "$p"; curl -fsS "http://127.0.0.1:$p/health"; echo; done
curl -fsS -o /dev/null -w 'web %{http_code}\n' http://127.0.0.1:5173/
docker compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Health}}'
```

Respuesta esperada: `{"service":"<nombre>-service","status":"ok"}`. **Limitación:** `/health` es una comprobación de vida estática; no verifica PostgreSQL ni las dependencias. Para comprobar la base, use la sección 5.

## 15. Detener servicios sin perder datos

| Comando                                   | Efecto                                                                             | Datos        |
| ----------------------------------------- | ---------------------------------------------------------------------------------- | ------------ |
| `docker compose stop` 🟡                  | Detiene contenedores; se conservan                                                 | Intactos     |
| `docker compose stop commerce-service` 🟡 | Detiene uno                                                                        | Intactos     |
| `docker compose down` 🟡                  | Elimina contenedores y redes; **conserva** el volumen `spectra-shop_postgres-data` | Intactos     |
| `docker compose down -v` 🔴               | **Elimina el volumen**: borra toda la base principal                               | **PERDIDOS** |

## 16. Reiniciar servicios

🟡

```bash
docker compose restart identity-service          # reinicia el proceso; no reconstruye ni migra
docker compose up -d --build --wait commerce-service   # reconstruye tras un cambio de código (re-ejecuta la cadena DT-09)
docker compose up -d --wait                      # reanuda todo tras un stop
```

Reiniciar Identity no invalida las sesiones (las claves ES256 vienen de archivo). Reiniciar Commerce dispara su reconciliación de arranque (sagas y DT-08), que es idempotente.

## 17. Respaldo y restauración aislada

### 17.1 Respaldo del stack principal 🟢 (solo lee la base)

```bash
umask 077
B="$HOME/spectra-backups/manual/$(date +%Y%m%d-%H%M%S)"; mkdir -p "$B"
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$B/spectra_shop.dump"
# Roles sin hashes de contraseña: tras restaurar, postgres-provision vuelve a fijarlas desde .env.
docker compose exec -T postgres sh -c 'pg_dumpall -U "$POSTGRES_USER" --globals-only --no-role-passwords' > "$B/globals.sql"
(cd "$B" && shasum -a 256 spectra_shop.dump globals.sql > SHA256SUMS && shasum -a 256 -c SHA256SUMS)
ls -la "$B"
```

Guarde también el conteo de tablas de la sección 13 en `$B/conteo-antes.txt`. Los respaldos contienen datos personales sintéticos: directorio `700`, archivos `600`, nunca dentro del repositorio.

### 17.2 Restauración en un contenedor desechable 🟡 (no toca el stack principal)

```bash
B="$HOME/spectra-backups/manual/<carpeta-del-respaldo>"
R="spectra-restore-$(date +%Y%m%d%H%M%S)"
ADMIN_ROLE="spectra_app"   # el POSTGRES_USER del stack principal (propietario original de la base)
docker run -d --name "$R" --network none \
  -e POSTGRES_USER=restore_admin -e POSTGRES_DB=postgres \
  -e POSTGRES_PASSWORD="$(openssl rand -hex 32)" \
  -v "$R-data:/var/lib/postgresql/data" postgres:16.6-alpine
until docker logs "$R" 2>&1 | grep -q 'PostgreSQL init process complete'; do sleep 1; done
until docker exec "$R" pg_isready -U restore_admin -d postgres >/dev/null 2>&1; do sleep 1; done
docker exec -i "$R" psql -X -q -U restore_admin -d postgres < "$B/globals.sql"
docker exec "$R" createdb -U restore_admin -O "$ADMIN_ROLE" spectra_shop
docker exec -i "$R" pg_restore -U restore_admin -d spectra_shop --exit-on-error < "$B/spectra_shop.dump"
```

Verificación 🟢: repita el conteo de tablas contra el contenedor restaurado y compárelo con `conteo-antes.txt`.

```bash
docker exec -i "$R" psql -X -q -At -U restore_admin -d spectra_shop <<'SQL' > "$B/conteo-restaurado.txt"
SELECT format('SELECT %L || ''|'' || count(*) FROM %I.%I', table_schema || '.' || table_name, table_schema, table_name)
  FROM information_schema.tables
 WHERE table_schema IN ('identity', 'catalog', 'commerce', 'audit') AND table_type = 'BASE TABLE'
 ORDER BY table_schema, table_name \gexec
SQL
diff "$B/conteo-antes.txt" "$B/conteo-restaurado.txt" && echo "Conteos idénticos"
```

Limpieza 🔴 (elimina **solo** el contenedor y el volumen de restauración; según la política del proyecto requiere autorización): `docker rm -f "$R" && docker volume rm "$R-data"`.

**Restaurar sobre la base principal** no está cubierto por esta guía: es una operación 🔴 que exige autorización, respaldo previo verificado y el procedimiento del [runbook DT-09](../runbooks/dt09-roles-postgresql.md) (paso 5 del rollback).

## 18. Ejecutar pruebas de forma segura

### 18.1 Pruebas sin base de datos 🟢

```bash
npm ci
npm run lint && npm run typecheck && npm test && npm run build
```

`npm test` en el host ejecuta solo pruebas unitarias: las suites de integración se omiten (`describe.skipIf`) cuando no hay variables `*_DATABASE_URL`. **Nunca exporte `DATABASE_URL`, `IDENTITY_DATABASE_URL`, `COMMERCE_DATABASE_URL` ni `AUDIT_DATABASE_URL` apuntando a la base principal** antes de `npm test`.

### 18.2 Pruebas de integración en un stack desechable 🟡 (destructivas dentro del stack desechable)

1. Prepare una configuración propia del stack desechable, con secretos nuevos y un ADMIN sintético (no imprime valores):

   ```bash
   umask 077
   D="$HOME/.config/spectra-shop/aislado"; mkdir -p "$D/keys"
   openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$D/keys/private.pem"
   openssl pkey -in "$D/keys/private.pem" -pubout -out "$D/keys/public.pem"; chmod 644 "$D/keys/public.pem"
   {
     echo "POSTGRES_DB=spectra_shop"; echo "POSTGRES_USER=spectra_app"
     echo "POSTGRES_PASSWORD=$(openssl rand -hex 32)"
     for r in IDENTITY_MIGRATOR IDENTITY_APP CATALOG_MIGRATOR CATALOG_APP COMMERCE_MIGRATOR COMMERCE_APP AUDIT_MIGRATOR AUDIT_APP; do
       echo "SPECTRA_${r}_PASSWORD=$(openssl rand -hex 32)"
     done
     t1="$(openssl rand -hex 32)"; t2="$(openssl rand -hex 32)"
     echo "SPECTRA_INTERNAL_TOKEN=$t1"; echo "SPECTRA_INTERNAL_TOKENS=$t1"
     echo "CATALOG_INVENTORY_TOKEN=$t2"; echo "CATALOG_INVENTORY_TOKENS=$t2"
     echo "SPECTRA_KEYS_DIR=$D/keys"
     echo "SYNTHETIC_ADMIN_EMAIL=admin.aislado@spectra.test"
     echo "SYNTHETIC_ADMIN_PASSWORD=$(openssl rand -hex 24)"
   } > "$D/.env"
   chmod 600 "$D/.env"
   ```

2. Defina un atajo que **siempre** use otro nombre de proyecto (y, por tanto, otro volumen):

   ```bash
   dca() { docker compose -p spectra-aislado --env-file "$HOME/.config/spectra-shop/aislado/.env" "$@"; }
   dca config --volumes        # 🟢 debe listar postgres-data → volumen real «spectra-aislado_postgres-data»
   ```

3. El stack desechable publica los mismos puertos que el principal. **Detenga el principal** (sin perder datos) y ejecute las suites como lo hace la CI:

   ```bash
   docker compose stop                                   # stack principal: datos intactos
   dca --profile test build identity-test catalog-test audit-test commerce-test db-isolation-test
   dca --profile test up -d --build --wait identity-service catalog-service
   dca --profile test run --rm db-isolation-test         # matriz DT-09
   dca --profile test run --rm identity-test             # BORRA los usuarios del stack desechable
   dca --profile test run --rm catalog-test              # espera 14 productos activos (no cree productos antes)
   dca --profile test run --rm audit-test
   dca --profile test run --rm commerce-test
   ```

   - `up --build` **no** reconstruye las imágenes `*-test`: ejecute siempre el `build` explícito.
   - Ejecute `commerce-test` sin `commerce-service` en marcha en ese proyecto: su reconciliador comparte la base y altera las pruebas DT-08.
   - Identity limita el registro a 10/min por IP: repetir `commerce-test` dentro del mismo minuto produce 429.
   - Tras `identity-test`, vuelva a sembrar el ADMIN: `dca run --rm --no-deps identity-migrate node dist/database/seed.js`.

4. Cierre del stack desechable 🔴 (borra **solo** `spectra-aislado_postgres-data`; compruebe el `-p` antes de ejecutarlo):

   ```bash
   dca --profile test down -v
   docker compose up -d --wait                           # vuelve a levantar el stack principal
   ```

Si necesita ambos stacks a la vez, añada un override **fuera del repositorio** que reasigne los puertos con `ports: !override [...]`. En ese caso, use el stack desechable solo por API (Postman, `scripts/mvp-e2e-smoke.mjs`): la Web compilada llama siempre a `127.0.0.1:3001–3004`.

### 18.3 Smoke E2E por HTTP 🟡 (escribe datos; solo stack desechable)

```bash
SPECTRA_E2E_IDENTITY_URL=http://127.0.0.1:3001 SPECTRA_E2E_CATALOG_URL=http://127.0.0.1:3002 \
SPECTRA_E2E_COMMERCE_URL=http://127.0.0.1:3003 node scripts/mvp-e2e-smoke.mjs
```

Úselo solo con el stack desechable levantado en esos puertos. Postman: [postman/README.md](postman/README.md).

## 19. Problemas frecuentes

| Síntoma                                                             | Causa probable                                                           | Solución                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `failed to connect to the docker API … docker.sock`                 | Docker Desktop no está en ejecución                                      | Inicie Docker Desktop y espere a que el motor esté listo.                    |
| `required variable X is missing a value: Define X in .env`          | Falta una variable en `.env`                                             | Complete `.env` (sección 3).                                                 |
| `bind: address already in use` en 3001–3004/5173                    | Otro proceso u otro proyecto Compose usa el puerto                       | `lsof -nP -iTCP:3001 -sTCP:LISTEN`; detenga el otro stack.                   |
| `postgres-provision` sale con error                                 | Contraseñas no hexadecimales, cortas o repetidas                         | `docker compose logs postgres-provision` y corrija `.env`.                   |
| Un `*-migrate` sale con error                                       | Migración fallida o permisos                                             | `docker compose logs <servicio>-migrate`; no edite migraciones aplicadas.    |
| `postgres-finalize`: «un rol de servicio conserva CREATE o TEMP»    | Privilegio residual                                                      | Ver [runbook DT-09](../runbooks/dt09-roles-postgresql.md).                   |
| Identity no arranca: «Configure claves ES256 fuera del repositorio» | `SPECTRA_KEYS_DIR` incorrecto o PEM ilegibles                            | Revise la ruta y permisos (UID 1000 en Linux).                               |
| La Web carga pero el login no persiste                              | Mezcla de `localhost` y `127.0.0.1`                                      | Use solo <http://127.0.0.1:5173>.                                            |
| 403 `CSRF_INVALID`                                                  | Falta `X-CSRF-Token`, cookie CSRF caducada (1 h) u `Origin` no permitido | Pida un token nuevo (`GET /auth/csrf`); use `Origin: http://127.0.0.1:5173`. |
| 401 `SESSION_EXPIRED`                                               | 30 min de inactividad u 8 h absolutas                                    | Inicie sesión de nuevo.                                                      |
| 429 `AUTH_LOCKOUT`                                                  | 5 contraseñas erróneas en 15 min                                         | Espere 15 min.                                                               |
| 429 `RATE_LIMIT_EXCEEDED`                                           | Límite por IP (registro 10/min, login 20/min, 120/min global)            | Espere un minuto.                                                            |
| 503 `IDENTITY_UNAVAILABLE` / `CATALOG_UNAVAILABLE`                  | Dependencia caída                                                        | `docker compose ps`; levante el servicio.                                    |
| La pantalla de auditoría falla                                      | `audit-service` no está en marcha                                        | `docker compose up -d --wait audit-service`.                                 |
| El evento `PRODUCT_CREATED` no aparece                              | El relay entrega cada ~5 s, con backoff si Audit falló                   | Espere y actualice; revise `audit_relay_deferred` en los logs de Catalog.    |
| Pruebas `*-test` con código antiguo                                 | `up --build` no reconstruye las imágenes `*-test`                        | `docker compose -p <desechable> --profile test build <x>-test`.              |

## 20. Qué servicio procesa cada operación

| Operación (Web)                      | Petición                                                            | Servicio                                                                                                               | Llamadas internas                                                                   |
| ------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Catálogo, búsqueda, filtro y detalle | `GET /categories`, `GET /products`, `GET /products/:id`             | Catalog 3002                                                                                                           | —                                                                                   |
| Token CSRF                           | `GET /auth/csrf`                                                    | Identity 3001                                                                                                          | —                                                                                   |
| Registro                             | `POST /auth/register`                                               | Identity 3001                                                                                                          | —                                                                                   |
| Login / refresh / logout / perfil    | `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `GET /auth/me` | Identity 3001                                                                                                          | —                                                                                   |
| Carrito                              | `GET /cart`, `POST /cart/items`, `PATCH`/`DELETE /cart/items/:id`   | Commerce 3003                                                                                                          | Identity 3101 (`validate-touch`), Catalog 3102 (`cart-snapshot`)                    |
| Resumen de checkout                  | `GET /checkout/summary`                                             | Commerce 3003                                                                                                          | Identity 3101, Catalog 3102                                                         |
| Confirmar pedido (saga)              | `POST /orders`                                                      | Commerce 3003                                                                                                          | Identity 3101; Catalog 3102 `stock-reservations` (reservar → confirmar → `fulfill`) |
| Mis pedidos                          | `GET /orders`, `GET /orders/:id`                                    | Commerce 3003                                                                                                          | Identity 3101                                                                       |
| ADMIN: nuevo producto                | `POST /admin/products`                                              | Catalog 3002                                                                                                           | Identity 3101; relay → Audit 3104                                                   |
| ADMIN: pedidos                       | `GET /admin/orders`                                                 | Commerce 3003                                                                                                          | Identity 3101                                                                       |
| ADMIN: auditoría                     | `GET /admin/audit-events`                                           | Audit 3004                                                                                                             | Identity 3101                                                                       |
| Procesos en segundo plano            | —                                                                   | Catalog: barrido de reservas vencidas, monitor DT-08, relay de outbox. Commerce: reconciliador de sagas y de `fulfill` | —                                                                                   |

Cada respuesta incluye la cabecera `X-Request-Id`: anótela al reportar un error para localizarlo en los logs.
