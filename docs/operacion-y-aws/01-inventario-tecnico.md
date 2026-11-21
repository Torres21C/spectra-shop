# Inventario técnico — SPECTRA Shop (`main` 2a27350)

- **Fecha:** 2026-11-20
- **Método:** lectura estática del código, la configuración y la documentación del repositorio, además de la arquitectura de referencia AWS de la bóveda académica (solo lectura). No se ejecutaron migraciones, pruebas ni servicios.
- **Público:** equipo del proyecto y revisión académica.

## 1. Estado de partida

| Elemento         | Estado verificado                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rama             | `main` = `origin/main` = `2a27350` (merge del PR #11, M06/M07 mínimos), árbol limpio                                                                                                                          |
| Stack principal  | **Detenido**: el demonio Docker no estaba en ejecución (`docker.sock` inexistente) y ningún puerto 3001–3004/5173 respondía. No se arrancó, para respetar la restricción de no iniciar ni reiniciar servicios |
| `compose.yaml`   | Válido (`docker compose config --quiet`) con el `.env` actual; 12 servicios por defecto y 17 con el perfil `test`                                                                                             |
| `.env` principal | Define las 16 variables obligatorias, incluidas las de audit. **No** define `SYNTHETIC_ADMIN_*` (sin ADMIN sintético en el stack principal). Se revisaron solo los nombres, nunca los valores                 |
| Base principal   | No verificable hoy. Según la bitácora M06/M07, las migraciones M06/M07 (`catalog.outbox_events`, esquema `audit`) aún no se le habían aplicado: el próximo `docker compose up` las aplicará                   |

## 2. Monorepo

| Paquete                 | Tecnología                                     | Puerto público / interno        | Esquema PostgreSQL | Swagger |
| ----------------------- | ---------------------------------------------- | ------------------------------- | ------------------ | ------- |
| `apps/web`              | React 19.3, Vite 8.3 (SPA con rutas hash)      | 5173 (`vite preview` en Docker) | —                  | —       |
| `apps/identity-service` | NestJS 12, Prisma 6.12, argon2id, jose (ES256) | 3001 / 3101                     | `identity`         | `/docs` |
| `apps/catalog-service`  | NestJS 12, Prisma 6.12                         | 3002 / 3102                     | `catalog`          | `/docs` |
| `apps/commerce-service` | NestJS 12, Prisma 6.12, decimal.js             | 3003 / —                        | `commerce`         | `/docs` |
| `apps/audit-service`    | NestJS 12, Prisma 6.12                         | 3004 / 3104                     | `audit`            | No      |
| `packages/contracts`    | Tipos TypeScript de transporte                 | —                               | —                  | —       |

Node 22.14 (Alpine 3.21, imagen fijada por digest), npm 11.19, PostgreSQL 16.6-alpine.

## 3. Rutas HTTP reales

Extraídas de los decoradores `@Controller`/`@Get`/`@Post`/`@Patch`/`@Delete`: **33 rutas**, de las cuales 24 son públicas y 9 internas.

### 3.1 Públicas (cubiertas por las colecciones Postman)

| Servicio | Método y ruta                        | Acceso                                                       | CSRF + Origin | Código OK           |
| -------- | ------------------------------------ | ------------------------------------------------------------ | ------------- | ------------------- |
| Identity | `GET /health`                        | Público                                                      | —             | 200                 |
| Identity | `GET /auth/csrf`                     | Público                                                      | —             | 200                 |
| Identity | `POST /auth/register`                | Público (rechaza 403 si ya hay sesión válida); 10/min por IP | Sí            | 201                 |
| Identity | `POST /auth/login`                   | Público; 20/min por IP                                       | Sí            | 201                 |
| Identity | `POST /auth/refresh`                 | Cookie de renovación; 30/min por IP                          | Sí            | 201                 |
| Identity | `POST /auth/logout`                  | Sesión                                                       | Sí            | 201                 |
| Identity | `GET /auth/me`                       | Sesión                                                       | —             | 200                 |
| Catalog  | `GET /health`                        | Público (sin throttling)                                     | —             | 200                 |
| Catalog  | `GET /categories`                    | Público                                                      | —             | 200                 |
| Catalog  | `GET /products?search&category&page` | Público                                                      | —             | 200                 |
| Catalog  | `GET /products/:id`                  | Público                                                      | —             | 200                 |
| Catalog  | `POST /admin/products`               | ADMIN                                                        | Sí            | 201                 |
| Commerce | `GET /health`                        | Público                                                      | —             | 200                 |
| Commerce | `GET /cart`                          | CLIENTE                                                      | —             | 200                 |
| Commerce | `POST /cart/items`                   | CLIENTE                                                      | Sí            | 200                 |
| Commerce | `PATCH /cart/items/:itemId`          | CLIENTE                                                      | Sí            | 200                 |
| Commerce | `DELETE /cart/items/:itemId`         | CLIENTE                                                      | Sí            | 200                 |
| Commerce | `GET /checkout/summary`              | CLIENTE                                                      | —             | 200                 |
| Commerce | `POST /orders` (`Idempotency-Key`)   | CLIENTE; 10 intentos/min por cuenta                          | Sí            | 201 / 200 (reenvío) |
| Commerce | `GET /orders?page`                   | CLIENTE                                                      | —             | 200                 |
| Commerce | `GET /orders/:orderId`               | CLIENTE (ajeno o inexistente → 404 uniforme)                 | —             | 200                 |
| Commerce | `GET /admin/orders?page`             | ADMIN                                                        | —             | 200                 |
| Audit    | `GET /health`                        | Público                                                      | —             | 200                 |
| Audit    | `GET /admin/audit-events?limit`      | ADMIN                                                        | —             | 200                 |

### 3.2 Internas (no publicadas al host)

| Servicio y puerto | Ruta                                                                                                                          | Protección                                                                             | Consumidor               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------ |
| Identity 3101     | `POST /internal/sessions/validate-touch`                                                                                      | `X-Spectra-Internal-Token` (`SPECTRA_INTERNAL_TOKENS`) + `Authorization: Bearer <JWT>` | Catalog, Commerce, Audit |
| Catalog 3102      | `POST /internal/catalog/cart-snapshot`                                                                                        | Token interno                                                                          | Commerce                 |
| Catalog 3102      | `POST /internal/catalog/stock-reservations`, `GET …/unfulfilled`, `GET …/:id`, `POST …/:id/confirm`, `…/fulfill`, `…/release` | Token de inventario (`CATALOG_INVENTORY_TOKENS`)                                       | Commerce (saga y DT-08)  |
| Audit 3104        | `POST /internal/audit/events`                                                                                                 | Token interno                                                                          | Relay de Catalog         |

## 4. Seguridad de la capa HTTP

- **Sesión:** JWT ES256 de 15 min en una cookie `HttpOnly` con `SameSite=Strict`; refresh opaco de 8 h con rotación y detección de reutilización; inactividad de 30 min. Nombres `spectra-*-dev` con `COOKIE_SECURE=false` y `__Host-spectra-*` con `true`.
- **Guards:** Identity usa `AccessGuard`. Catalog, Commerce y Audit verifican el JWT localmente con la clave pública y además consultan `validate-touch` en Identity; el usuario, la sesión y el rol deben coincidir. Commerce usa `CartAccessGuard` (solo CLIENTE) y los servicios con rutas `/admin` usan `AdminAccessGuard` (solo ADMIN).
- **CSRF:** doble envío (cookie + `X-CSRF-Token`, comparación en tiempo constante) y `Origin` incluido en `CORS_ORIGINS`. Se comprueba dentro del controlador, después del guard y del `ValidationPipe`.
- **Validación:** `ValidationPipe` global con `whitelist`, `forbidNonWhitelisted`, `transform` y `stopAtFirstError`. Límite de cuerpo de 16 KB (4 KB en el listener interno de Identity y 256 KB en la ingesta de Audit).
- **Errores:** formato uniforme `{statusCode, code, message, requestId, timestamp}` con una lista blanca de códigos por servicio; los detalles internos nunca se exponen.
- **Cabeceras:** Helmet con CSP `default-src 'none'` en las API y sin `x-powered-by`. Commerce y Audit responden con `Cache-Control: no-store`.
- **Rate limiting:** `@nestjs/throttler` en memoria con 120/min por IP en Identity, Catalog y Commerce. **Audit no tiene throttling.** No hay `trust proxy` configurado.

## 5. Datos y migraciones

| Esquema    | Tablas                                                                                          | Migraciones | Permisos del rol `*_app`                                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `identity` | roles, users, auth_sessions, refresh_tokens, outbox_events                                      | 1           | SELECT en roles; S/I/U en users, sesiones y tokens; S/I en outbox                                                          |
| `catalog`  | categories, products, stock_reservations, stock_reservation_lines, outbox_events                | 5           | SELECT categories; S/I products + UPDATE(stock, updated_at); S/I/U reservas; S/I líneas; S/I outbox + UPDATE(published_at) |
| `commerce` | carts, cart_items, checkout_attempts, orders, order_items, outbox_events (+ `order_number_seq`) | 5           | S/I/U carts e intentos; S/I/U/D cart_items; S/I orders, order_items y outbox; USAGE de la secuencia                        |
| `audit`    | audit_events                                                                                    | 1           | Solo SELECT e INSERT (append-only)                                                                                         |

- Aprovisionamiento DT-09 (`infra/postgres/*.sql`): 8 roles sin privilegios especiales, propiedad del esquema para cada migrador, revocación de PUBLIC y una ventana temporal de `CREATE` sobre la base. El rollback está documentado.
- Seeds: Identity crea los roles CLIENTE/ADMIN y, si se configura, el ADMIN sintético. Catalog inserta 3 categorías y 15 productos (14 activos) y solo añade las filas que faltan.
- Outbox: las de **Identity y Commerce acumulan eventos que nadie entrega** (el runtime de Commerce no tiene `UPDATE(published_at)`). Solo Catalog tiene relay hacia Audit, que acepta únicamente `catalog/PRODUCT_CREATED`.

## 6. Compose, imágenes y CI

- **Compose:** las redes `edge` y `backend` (`internal: true`, donde vive PostgreSQL, sin puerto en el host) y el volumen `postgres-data`. Los jobs de un solo uso son `postgres-provision`, `*-migrate` y `postgres-finalize`. El perfil `test` añade `identity-test`, `catalog-test`, `commerce-test`, `audit-test` (target `build`) y `db-isolation-test`. **Los servicios `*-test` usan el mismo `postgres` y el mismo volumen que el proyecto donde se ejecutan.**
- **Dockerfiles:** multi-etapa, `USER node` y base fijada por digest. La etapa final copia **todo `node_modules`, incluidas las devDependencies** (Prisma CLI, Vite, Vitest, TypeScript), porque los jobs de migración usan `./node_modules/.bin/prisma` desde la imagen de runtime. La Web sirve el build con `vite preview`.
- **CI (`.github/workflows/ci.yml`):** formato, lint, tipos, pruebas unitarias e integración en Compose (credenciales efímeras), build, Gitleaks, Semgrep (14 reglas propias), `npm audit --omit=dev`, SBOM CycloneDX y OWASP Dependency-Check. **No** construye ni publica imágenes, **no** escanea imágenes y **no** despliega. Permisos `contents: read`.
- **Excepción SCA:** `.dependency-check/suppressions.xml` suprime GHSA-fc5q-39xc-vjpf (picomatch 4.0.7) hasta el **2026-12-17**, «solo para el MVP académico local; no acepta el riesgo para producción ni despliegue en AWS».

## 7. Documentación existente

ADR M04-01, M05-01, M06-0-01 y M06-0-02; runbooks DT-09 y de sagas atascadas; cierre operativo de M06.0; propuesta funcional de M06; README con la API por módulo. En la bóveda: arquitectura AWS de la Fase 2 (`03-Fase-2/Fase2_Arquitectura_AWS.md`), ERS, STRIDE y la matriz de trazabilidad. Los mockups del prototipo académico se consultaron solo como referencia funcional; esta tarea no los usa ni los modifica.

## 8. Discrepancias detectadas (no corregidas: solo se autorizó crear documentación)

| #    | Discrepancia                                                                                                                                                                                                                                                             | Evidencia                                                | Recomendación                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| I-01 | La sección «Comandos» del README lista `docker compose --profile test run --rm identity-test` (y el resto de suites) sin indicar que, en el proyecto principal, **borran datos de la base principal**. La advertencia solo aparece al final, y solo para `identity-test` | `README.md`, sección «Comandos»                          | Añadir la advertencia y el uso de `-p <proyecto-desechable>` (ver la guía, sección 18) |
| I-02 | `COOKIE_SECURE` e `IDENTITY_ALLOW_EPHEMERAL_KEYS` figuran en `.env.example`, pero `compose.yaml` fija sus valores por servicio                                                                                                                                           | `.env.example`, `compose.yaml`                           | Aclararlo en `.env.example`                                                            |
| I-03 | `web` depende de Identity, Catalog y Commerce, pero no de Audit: `docker compose up web` deja la pantalla de auditoría sin backend                                                                                                                                       | `compose.yaml` (`web.depends_on`)                        | Documentarlo o añadir la dependencia                                                   |
| I-04 | El valor por defecto de `IDENTITY_INTERNAL_URL` en Commerce apunta al puerto **público** 3001 (Catalog y Audit usan 3101); Compose lo corrige con una variable explícita                                                                                                 | `apps/commerce-service/src/config/commerce.config.ts:41` | Alinear el valor por defecto a 3101                                                    |
| I-05 | El runbook DT-09 y el ADR-M06-0-01 describen 3 servicios y 6 roles; desde M07 son 4 servicios y 8 roles                                                                                                                                                                  | `docs/runbooks/dt09-roles-postgresql.md`                 | Actualizar el texto                                                                    |
| I-06 | Audit no tiene throttling ni Swagger, a diferencia del resto                                                                                                                                                                                                             | `apps/audit-service/src/app.module.ts`                   | Valorar `ThrottlerGuard` (ver diagnóstico AWS-15)                                      |
