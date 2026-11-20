# Colecciones Postman — SPECTRA Shop

Colecciones **Postman Collection v2.1** construidas a partir de los controladores, DTO y guards reales de `main` (`2a27350`). Cubren las **24 rutas HTTP públicas** de los cuatro servicios; no hay endpoints inventados.

| Archivo                                          | Contenido                                                                                                                                                         | Escribe datos                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `spectra-shop-api.postman_collection.json`       | Referencia **por servicio** (Identity, Catalog, Commerce, Audit), con carpetas separadas de lectura, escritura y negativos. 72 peticiones.                        | Solo las carpetas «Escritura», «Sesión» y las peticiones marcadas `[ESCRIBE]` |
| `spectra-shop-flujo-e2e.postman_collection.json` | **Flujo completo en orden** para el Collection Runner: salud → catálogo → registro → carrito → checkout → pedidos → pedido ajeno → administración. 71 peticiones. | **Sí** (ver advertencias)                                                     |
| `spectra-shop-local.postman_environment.json`    | Entorno del stack principal (`127.0.0.1:3001–3004`).                                                                                                              | —                                                                             |
| `spectra-shop-aislado.postman_environment.json`  | Stack desechable `-p spectra-aislado` (mismos puertos `3001–3004`, con el principal detenido; cámbielos si usa un override de puertos).                           | —                                                                             |

## 1. Importación

1. Use **Postman Desktop**. Las peticiones envían la cabecera `Origin`, que el agente web de Postman puede bloquear.
2. _Import_ → seleccione los cuatro archivos JSON de esta carpeta.
3. Seleccione el entorno en la esquina superior derecha.
4. Si va a ejecutar la parte ADMIN, rellene **solo el valor actual (Current value)** de `adminEmail` y `adminPassword` con el ADMIN sintético del stack (`SYNTHETIC_ADMIN_EMAIL`/`SYNTHETIC_ADMIN_PASSWORD` de su `.env`). No exporte ni comparta el entorno con esos valores.

No hay credenciales reales en estos archivos. Los clientes de prueba se generan en tiempo de ejecución (`postman.cliente.<timestamp>@example.test` y una contraseña aleatoria) si `clienteEmail`/`clientePassword` están vacíos.

## 2. Cómo autentica la API (implementación real)

- **No hay tokens Bearer públicos.** Identity emite cookies `HttpOnly` con `SameSite=Strict`:
  - HTTP local (`COOKIE_SECURE=false`, el valor de `compose.yaml`): `spectra-access-dev` (JWT ES256, 15 min), `spectra-refresh-dev` (opaca, 8 h) y `spectra-csrf-dev` (1 h).
  - HTTPS (`COOKIE_SECURE=true`): `__Host-spectra-access`, `__Host-spectra-refresh` y `__Host-spectra-csrf`, con `Secure`. Postman no las envía por `http://`.
- El **cookie jar** de Postman guarda las cookies por dominio (`127.0.0.1`) y las envía a todos los puertos, igual que el navegador. Por eso un login en Identity (3001) autentica también en Catalog, Commerce y Audit.
- **Una sesión a la vez:** el último login (cliente A, cliente B o ADMIN) sustituye las cookies. Las carpetas indican qué sesión necesitan.
- **Escrituras:** `POST`, `PATCH` y `DELETE` exigen `X-CSRF-Token: {{csrfToken}}` (de `GET /auth/csrf`, que también fija la cookie) y `Origin: {{webOrigin}}` incluido en `CORS_ORIGINS`. `POST /orders` exige además `Idempotency-Key` (UUID v4).
- **Roles:** `CLIENTE` para carrito, checkout y pedidos (ADMIN → 403); `ADMIN` para `/admin/*` (CLIENTE → 403). Cada servicio verifica el JWT localmente y valida la sesión en Identity (`validate-touch`).
- Las peticiones negativas «sin cookies» usan `protocolProfileBehavior.disableCookies` para no enviar el cookie jar.
- Postman no aplica CORS. Las pruebas de CSRF y `Origin` sí se comprueban, porque las aplica el servidor.

## 3. Variables

| Variable                                                                                                   | Ámbito           | Uso                                                                                      |
| ---------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| `identityUrl`, `catalogUrl`, `commerceUrl`, `auditUrl`                                                     | Entorno          | URL base de cada servicio                                                                |
| `webOrigin`                                                                                                | Entorno          | Cabecera `Origin` (por defecto `http://127.0.0.1:5173`)                                  |
| `categoryId`, `categorySlug`, `productId`, `existingSku`                                                   | Entorno          | Datos del seed. `GET /products` sustituye `productId` por el primer producto `AVAILABLE` |
| `clienteEmail`, `clientePassword`, `cliente2Email`, `cliente2Password`                                     | Entorno (vacías) | Opcionales; si están vacías el registro las genera                                       |
| `adminEmail`, `adminPassword`                                                                              | Entorno (vacías) | ADMIN sintético; sin ellas, las peticiones ADMIN se **omiten**                           |
| `csrfToken`, `cartItemId`, `cartFingerprint`, `idempotencyKey`, `orderId`, `newProductSku`, `newProductId` | Colección        | Estado del flujo, fijado por los scripts                                                 |

Los scripts escriben con `setVar`: si la variable existe en el entorno la actualizan allí (valor actual) y, si no, en la colección. Así ningún valor vacío del entorno oculta uno generado.

## 4. Pruebas automáticas incluidas

- Cada petición comprueba el código HTTP esperado y la estructura del cuerpo (contratos de `packages/contracts`).
- Los errores comprueban el formato uniforme `{ statusCode, code, message, requestId, timestamp }` y el `code` exacto (`AUTH_REQUIRED`, `CSRF_INVALID`, `REQUEST_REJECTED`, `SKU_DUPLICATED`, `ORDER_NOT_FOUND`, …).
- A nivel de colección: ninguna respuesta 5xx y presencia de `X-Request-Id`.
- Las peticiones principales incluyen **ejemplos de respuesta**. Están construidos a partir del código y de los contratos (identificadores sintéticos); **no son capturas** de una ejecución real.

## 5. Orden recomendado del flujo completo

Con el **stack desechable** completo levantado y saludable y el entorno «aislado» seleccionado. Desde la raíz del repositorio, con el atajo `dca` de la [guía, sección 18.2](../02-guia-operacion-local.md#18-ejecutar-pruebas-de-forma-segura):

```bash
docker compose stop                 # stack principal: se detiene sin perder datos
dca up -d --build --wait            # stack desechable completo, con ADMIN sintético
grep '^SYNTHETIC_ADMIN_' "$HOME/.config/spectra-shop/aislado/.env"   # credencial sintética para el valor actual del entorno
```

1. _Runner_ → colección **«Flujo E2E (ESCRIBE DATOS)»** → entorno «aislado» → **Run**, en el orden de carpetas:

   | Carpeta                            | Qué hace                                                                                                                                 | Sesión    | Escribe                     |
   | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------- |
   | 01 Salud                           | 4 × `/health`                                                                                                                            | —         | No                          |
   | 02 Catálogo público                | categorías, listado, búsqueda, filtro, detalle                                                                                           | —         | No                          |
   | 03 Negativos sin sesión            | 401 en las 5 áreas protegidas, 400/404 de catálogo                                                                                       | —         | No                          |
   | 04 Registro y sesión del cliente A | CSRF, 400/403 de registro y login, registro, login, perfil, refresh                                                                      | Cliente A | Usuario y sesión            |
   | 05 Carrito                         | obtener, agregar, cambiar cantidad, eliminar, volver a agregar                                                                           | Cliente A | Carrito                     |
   | 06 Checkout y pedidos              | resumen, 400 sin clave y con tarjeta, pedido APROBADO, reenvío idempotente, historial, detalle                                           | Cliente A | **Pedido y stock**          |
   | 07 Negativos con sesión CLIENTE    | 403 sin CSRF, 400 de validación, 404 inexistente, 403 en rutas ADMIN, logout, 401 tras logout                                            | Cliente A | Revoca la sesión            |
   | 08 Pedido ajeno (cliente B)        | registro y login de B, `GET /orders/<pedido de A>` → 404, logout                                                                         | Cliente B | Usuario B y `ACCESS_DENIED` |
   | 09 Administración (ADMIN)          | login ADMIN, pedidos y auditoría, 403/400/409, **alta de producto**, verificación pública y llegada de `PRODUCT_CREATED` a Audit, logout | ADMIN     | **Producto irreversible**   |

2. Ejecute el flujo **una sola vez por minuto**: Identity limita el registro a 10/min y el login a 20/min por IP.
3. La petición que busca `PRODUCT_CREATED` espera 7 s (el relay entrega cada ~5 s). Si falla, repítala sola unos segundos después.

Para explorar la colección **por servicio** a mano, ejecute antes «Identity › Lectura › GET /auth/csrf» y el login que indique cada carpeta.

## 6. ⚠️ Advertencias sobre operaciones de escritura

- **Nunca ejecute el flujo E2E ni las carpetas de escritura contra el stack principal.** El entorno «local» apunta a la base persistente: úselo solo con peticiones `[LECTURA]` y `[NEG]` que no digan `[ESCRIBE]`.
- `[ESCRIBE][IRREVERSIBLE] POST /admin/products` crea un producto **activo** que no puede editarse, desactivarse ni borrarse por API (RN-23). Además rompe la prueba CA-M01-01 de `catalog-test`, que espera 14 productos.
- `POST /orders` (APROBADO) **descuenta stock** mediante la saga Commerce→Catalog y crea un pedido que no puede cancelarse (RN-22, RN-25 pendiente).
- `POST /auth/register` crea usuarios que no pueden eliminarse por API.
- `GET /cart` crea un carrito vacío si el cliente no tiene uno (marcado `[ESCRIBE*]`).
- Toda petición autenticada puede actualizar `auth_sessions.last_activity_at` (toque de sesión). No es un dato de negocio, pero es una escritura.
- `[NEG][ESCRIBE] GET /orders/<ajeno>` registra `ACCESS_DENIED` y `[NEG][ESCRIBE] POST /auth/login` con credenciales erróneas registra `AUTH_LOGIN_FAILURE`, ambos en la outbox de su servicio. El login erróneo usa un correo inexistente a propósito para no bloquear una cuenta real.
- Escrituras que **no** se producen: 409 de SKU duplicado (la transacción se revierte), 403 por rol o CSRF y 400 por validación (se rechazan antes de llegar al servicio).

## 7. Fuera de alcance

- **Listeners internos** (no publicados al host; exigen `X-Spectra-Internal-Token` o el token de inventario): `POST /internal/sessions/validate-touch` (Identity 3101); `POST /internal/catalog/cart-snapshot` y `/internal/catalog/stock-reservations[/…/confirm|fulfill|release|unfulfilled]` (Catalog 3102); `POST /internal/audit/events` (Audit 3104). Incluirlos obligaría a distribuir tokens de servicio.
- **Swagger/OpenAPI**: `/docs` y `/docs-json` en Identity, Catalog y Commerce (Audit no tiene). Sirven de referencia, pero no son parte de la API funcional.
- Escenarios que exigen manipular estado (stock insuficiente concurrente, saga atascada, sesión expirada por inactividad) están cubiertos por las suites de integración, no por Postman.

## 8. Validación realizada (2026-11-20)

| Comprobación                                                                   | Resultado                                                                                      |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| JSON bien formado (4 archivos)                                                 | OK (`jq`)                                                                                      |
| Esquema oficial Postman Collection v2.1.0 (2 colecciones)                      | Válido (ajv, esquema de `schema.getpostman.com`)                                               |
| Correspondencia URL ↔ decoradores de los controladores                         | 24/24 rutas públicas cubiertas; 0 peticiones sin ruta en el código; 9 rutas internas excluidas |
| Sintaxis de los 189 scripts                                                    | 0 errores                                                                                      |
| Prueba en seco de los scripts de test contra sus ejemplos (pm simulado + chai) | 32 ejemplos, 132 aserciones correctas                                                          |
| **Ejecución real contra un stack**                                             | **PENDIENTE**: Docker estaba detenido y no se arrancaron servicios (restricción de la tarea)   |
