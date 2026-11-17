# SPECTRA Shop

Aplicación académica de comercio electrónico cloud-native. El código vive en este monorepo y la documentación académica se conserva en la bóveda Obsidian.

## Estado

M01 Catálogo, M02 Identidad, M03 Carrito, M04 Checkout y su endurecimiento M04.1 están integrados en `main`. M04 incorpora el checkout con pago **simulado**, pedidos con precios congelados y una saga orquestada por Commerce con reservas de inventario en Catalog ([ADR-M04-01](docs/adr/ADR-M04-01-checkout-saga.md)). M05 añade el historial, el detalle y la línea de tiempo de los pedidos propios del cliente ([ADR-M05-01](docs/adr/ADR-M05-01-gestion-pedidos.md)) y M06.0 los prerrequisitos DT-08/DT-09; ambos están integrados en `main`. El flujo MVP completo (registro → login → catálogo → carrito → checkout → pedido) funciona desde la Web; véase [Demostración del MVP](#demostración-del-mvp). La administración de pedidos (M06) y la consulta de auditoría (M07) no están implementadas. No existe despliegue en AWS ni integración con pagos reales; no se solicitan ni almacenan datos de tarjeta.

## Arquitectura

- `apps/web`: React + Vite.
- `apps/identity-service`: identidad y sesiones.
- `apps/catalog-service`: catálogo e inventario.
- `apps/commerce-service`: carrito, checkout simulado y pedidos (M03–M05).
- `apps/audit-service`: auditoría append-only.
- `packages/contracts`: contratos compartidos de transporte, sin lógica de dominio.

Se aplica KISS: cada servicio empieza con el mínimo necesario y crece únicamente cuando un requisito verificable lo exige.

## Requisitos locales

- Node.js 22 LTS o 24.
- npm 10 o superior.
- Docker con Compose.

## Inicio rápido

```bash
cp .env.example .env
npm ci

# Genere la clave ES256 fuera del repositorio y configure SPECTRA_KEYS_DIR en .env.
mkdir -p /ruta/privada/spectra-dev-keys
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \
  -out /ruta/privada/spectra-dev-keys/private.pem
openssl pkey -in /ruta/privada/spectra-dev-keys/private.pem -pubout \
  -out /ruta/privada/spectra-dev-keys/public.pem

# Genere fuera del repositorio dos tokens distintos y copie los valores únicamente a .env:
# SPECTRA_INTERNAL_TOKEN(S) para lecturas internas y CATALOG_INVENTORY_TOKEN(S) para inventario.
openssl rand -hex 32
openssl rand -hex 32

# DT-09: seis contraseñas distintas, de migración y de ejecución por servicio
# (SPECTRA_<SERVICIO>_MIGRATOR_PASSWORD y SPECTRA_<SERVICIO>_APP_PASSWORD en .env).
for i in 1 2 3 4 5 6; do openssl rand -hex 32; done

npm run build
docker compose up --build
```

Antes de usar `.env`, sustituya la contraseña de ejemplo por un valor local aleatorio. `.env` nunca debe versionarse.

Una vez que los contenedores estén saludables:

- aplicación: <http://127.0.0.1:5173>;
- API de catálogo: <http://127.0.0.1:3002/products>;
- Swagger UI: <http://127.0.0.1:3002/docs>;
- OpenAPI JSON: <http://127.0.0.1:3002/docs-json>.
- API de identidad: <http://127.0.0.1:3001/auth/csrf>;
- Swagger de identidad: <http://127.0.0.1:3001/docs>.
- API de carrito, checkout y pedidos: <http://127.0.0.1:3003/cart>, <http://127.0.0.1:3003/checkout/summary>, <http://127.0.0.1:3003/orders>;
- «Mis pedidos» (P07): <http://127.0.0.1:5173/#/pedidos>;
- Swagger de Commerce: <http://127.0.0.1:3003/docs>.

Cada servicio se conecta a PostgreSQL con su propio rol de ejecución, con permisos mínimos sobre su esquema. Antes de que arranquen los servicios, `postgres-provision` crea los roles, los jobs `*-migrate` aplican migraciones y seeds con el rol migrador propietario de cada esquema y `postgres-finalize` cierra la ventana de migración (DT-09, [runbook](docs/runbooks/dt09-roles-postgresql.md)). `POSTGRES_USER` es solo el administrador del clúster. PostgreSQL no publica su puerto al host. Las claves ES256 y la credencial interna se suministran desde rutas o variables locales no versionadas. Los listeners internos de Catalog (`3102`) e Identity (`3101`) sólo existen en la red privada de Compose y no se publican al host.

## Comandos

```bash
npm run lint
npm run typecheck
npm test
npm run test:cov
npm run build
docker compose --profile test run --rm catalog-test
docker compose --profile test run --rm identity-test
docker compose --profile test run --rm commerce-test
docker compose --profile test run --rm db-isolation-test   # DT-09: matriz de privilegios PostgreSQL
```

Las tres últimas órdenes ejecutan las pruebas de integración contra PostgreSQL dentro de la red privada de Compose. `identity-test` levanta un servidor HTTPS local con un certificado efímero y comprueba cookies `Secure` reales. `commerce-test` usa comunicación HTTP real entre Commerce, Catalog e Identity; las claves y los tokens internos siguen siendo obligatorios. Las pruebas M04 interponen un proxy HTTP de fallos entre Commerce y Catalog para reproducir caídas, respuestas perdidas, vencimientos y reinicios sin alterar el código productivo.

## API M01

| Método | Ruta                                                   | Función                                     |
| ------ | ------------------------------------------------------ | ------------------------------------------- |
| `GET`  | `/categories`                                          | Categorías activas para el filtro           |
| `GET`  | `/products?page=1&search=teclado&category=perifericos` | Listado paginado, búsqueda literal y filtro |
| `GET`  | `/products/:id`                                        | Detalle uniforme de un producto activo      |

El tamaño de página es 12 y lo controla el servidor. La API nunca expone el stock exacto: responde `OUT_OF_STOCK`, `LOW_STOCK` o `AVAILABLE`.

## API M02

| Método | Ruta             | Función                                             |
| ------ | ---------------- | --------------------------------------------------- |
| `GET`  | `/auth/csrf`     | Token CSRF ligado a cookie                          |
| `POST` | `/auth/register` | Registro exclusivo con rol `CLIENTE`                |
| `POST` | `/auth/login`    | Sesión persistente y cookies de acceso/renovación   |
| `POST` | `/auth/refresh`  | Rotación del refresh token                          |
| `POST` | `/auth/logout`   | Revocación inmediata dentro de `identity-service`   |
| `GET`  | `/auth/me`       | Perfil del propietario de la sesión, sin ID externo |

El access token ES256 expira en un máximo de 15 minutos. La sesión expira tras 30 minutos de inactividad o a las ocho horas absolutas. El frontend no almacena tokens en Web Storage. En HTTP local se usan cookies `spectra-*-dev` con `Secure=false`; la política HTTPS usa cookies `__Host-*`, `HttpOnly`, `Secure` y `SameSite=Strict`.

Commerce verifica localmente firma, algoritmo, emisor, audiencia y expiración del JWT y además consulta a Identity mediante `validate/touch`; por ello falla cerrado ante sesiones revocadas, inactivas o absolutas expiradas. La ventana de revocación de hasta 15 minutos permanece como riesgo residual para otros microservicios que aún no usen esta validación. MFA, recuperación y verificación de correo continúan fuera del alcance de M02.

## API M03

| Método   | Ruta                  | Función                                              |
| -------- | --------------------- | ---------------------------------------------------- |
| `GET`    | `/cart`               | Obtiene el carrito y revalida precio, estado y stock |
| `POST`   | `/cart/items`         | Agrega o incrementa una línea propia                 |
| `PATCH`  | `/cart/items/:itemId` | Reemplaza la cantidad de una línea propia            |
| `DELETE` | `/cart/items/:itemId` | Elimina una línea propia y recalcula el total        |

Sólo el rol `CLIENTE` puede usar estas rutas. Las mutaciones requieren cookie de sesión, token CSRF y `Origin` permitido. El servidor rechaza campos no declarados y calcula en GTQ con `Decimal`, redondeo `HALF_UP` y dos decimales. Una indisponibilidad de Catalog o Identity produce `503`; no se usan precios ni totales obsoletos. Mientras un checkout está en curso, el carrito queda congelado (`409 CART_LOCKED_FOR_CHECKOUT`).

La comunicación interna usa un token aleatorio de al menos 32 caracteres comparado en tiempo constante. `SPECTRA_INTERNAL_TOKENS` acepta el token actual y el anterior durante una rotación; Commerce envía sólo el actual. En una futura implantación AWS, la interfaz de configuración permitirá obtener la credencial desde Secrets Manager y las claves ES256 desde KMS, sin que M03 despliegue ni consuma esos servicios.

## API M04

| Método | Ruta                | Función                                                                                           |
| ------ | ------------------- | ------------------------------------------------------------------------------------------------- |
| `GET`  | `/checkout/summary` | Resumen recalculado en servidor y huella (`fingerprint`) del resumen                              |
| `POST` | `/orders`           | Confirma el pedido con pago simulado; exige `Idempotency-Key` (UUID v4)                           |
| `GET`  | `/orders/:orderId`  | Pedido propio (desde M05, ampliado con estado y línea de tiempo); ajeno o inexistente → 404 igual |

Cuerpo de `POST /orders`: datos de entrega ficticios (`recipientName`, `phone`, `department`, `municipality`, `address`, `references` opcional), `simulatedPaymentResult` (`APROBADO` o `RECHAZADO`) y `cartFingerprint`. Cualquier otro campo —`total`, `price`, `userId`, `cardNumber`, `cvv`…— se rechaza con `400`. El total es la suma de precios persistidos × cantidad, congelados en `order_items`.

| Resultado                      | HTTP | Código                                               |
| ------------------------------ | ---- | ---------------------------------------------------- |
| Pedido creado                  | 201  | —                                                    |
| Reenvío con la misma clave     | 200  | — (mismo pedido)                                     |
| Pago simulado rechazado        | 422  | `PAYMENT_SIMULATED_REJECTED`                         |
| Stock insuficiente             | 409  | `CHECKOUT_STOCK_CONFLICT` (con líneas afectadas)     |
| Precio o cantidades cambiadas  | 409  | `CHECKOUT_SUMMARY_CHANGED`                           |
| Confirmación en curso          | 409  | `CHECKOUT_IN_PROGRESS`                               |
| Clave reutilizada / vencida    | 422  | `IDEMPOTENCY_KEY_REUSED` / `IDEMPOTENCY_KEY_EXPIRED` |
| Saga pendiente (fallo técnico) | 503  | `CHECKOUT_PENDING`: reintentar con la misma clave    |
| Límite por cuenta              | 429  | `CHECKOUT_RATE_LIMITED`                              |

### Saga de checkout

Commerce orquesta la compra con transacciones ACID locales y sin acceder a tablas de Catalog:

1. **C1 · Commerce**: crea el intento `STARTED` por (usuario, `Idempotency-Key`) con el carrito bloqueado; un índice único parcial permite un solo checkout en curso por carrito.
2. **Validación**: precios y stock vigentes desde Catalog, huella del resumen y resultado del pago simulado. Un rechazo termina aquí sin tocar stock.
3. **R · Catalog**: reserva todo-o-nada con `UPDATE … WHERE stock >= cantidad AND precio = esperado`, en orden por producto, más `CHECK stock >= 0`.
4. **K · Catalog**: confirmación, el punto de no retorno; rechaza reservas vencidas según el reloj de la base de datos.
5. **C3 · Commerce**: pedido `PAGADO`, líneas con precio congelado, carrito `CONVERTIDO` y evento `ORDER_CREATED` en la outbox, todo en una transacción local.

Compensación y recuperación: si la saga no llega a **K**, la reserva se libera de forma idempotente. Desde M04.1 el reconciliador reintenta con backoff exponencial acotado (`CHECKOUT_RECOVERY_BACKOFF_BASE_MS`/`_MAX_MS`), declara atascada una saga por antigüedad (`CHECKOUT_STUCK_AGE_MS`) o por reintentos (`CHECKOUT_STUCK_ATTEMPTS`), emite una única alerta `CHECKOUT_SAGA_STUCK` y publica métricas `checkout_saga_metrics` en cada ciclo. **Nunca abandona una saga ni libera stock confirmado después de K**; el procedimiento operativo está en [docs/runbooks/checkout-sagas-atascadas.md](docs/runbooks/checkout-sagas-atascadas.md). Catalog libera además las reservas `PENDING` vencidas (barrido periódico y al arrancar). Commerce reconcilia al arrancar y periódicamente los intentos cuyo arrendamiento venció: hacia atrás si Catalog no confirmó, hacia adelante si ya confirmó. Los estados técnicos de la saga (`checkout_attempts.state`) están separados de los estados de negocio del pedido (`orders.status`).

Los endpoints internos de inventario (`/internal/catalog/stock-reservations`) existen solo en el listener `3102` y exigen `CATALOG_INVENTORY_TOKEN(S)`, distinto del token compartido de lectura.

### Límites de M04

- Si Commerce falla de forma permanente o pierde sus datos **después de K**, el stock confirmado queda retenido sin pedido y Catalog todavía no lo detecta (R27, CTL-39 parcial; confirmación de entrega pendiente antes de M06). Ver «Garantías y límites» en la [ADR-M04-01](docs/adr/ADR-M04-01-checkout-saga.md).
- Todas las respuestas de Commerce envían `Cache-Control: no-store` y `Pragma: no-cache` (M04.1).
- La entrega de la outbox a `audit-service` corresponde a M07; los eventos quedan persistidos en `commerce.outbox_events`.
- Los servicios comparten un usuario PostgreSQL local; los roles por esquema siguen pendientes.
- DAST/ZAP, TLS y controles AWS no están implementados. Completar M04 no completa las Fases 3 ni 4.

## API M05

| Método | Ruta               | Función                                                                                 |
| ------ | ------------------ | --------------------------------------------------------------------------------------- |
| `GET`  | `/orders?page=1`   | Historial de pedidos propios, del más reciente al más antiguo; 10 por página (servidor) |
| `GET`  | `/orders/:orderId` | Detalle: líneas con precio congelado, entrega, total, estado vigente y línea de tiempo  |

Sólo el rol `CLIENTE` puede usar estas rutas (`ADMIN` → 403; la consulta administrativa pertenece a M06). El propietario sale siempre de la sesión validada en Identity: la consulta filtra por `user_id` en la base de datos (RN-20). La API identifica los pedidos por UUID v4; el número `SP-…` es sólo informativo (RN-21) y un identificador que no sea UUID v4 responde `400`. Un pedido ajeno y uno inexistente responden el mismo `404 ORDER_NOT_FOUND`; el intento sobre un pedido ajeno se registra como `ACCESS_DENIED` en `commerce.outbox_events`, sin tokens, cookies ni datos de entrega, hasta que M07 lo entregue a `audit-service`.

- **Paginación:** el tamaño de página es fijo (10) y lo decide el servidor; `page` admite enteros 1–10 000. Cualquier otro parámetro (`pageSize`, `limit`, `userId`…) se rechaza con `400`. El orden es estable (`created_at` descendente con desempate por `id`). Una página posterior a la última devuelve `items: []` con los metadatos reales.
- **Línea de tiempo:** columnas de fecha por estado (`paid_at`, `preparing_at`, `shipped_at`, `delivered_at`, `cancelled_at`). Dos restricciones `CHECK` exigen que cada estado tenga exactamente las fechas de los estados por los que pasó (RN-24) y que sean cronológicas; `statusChangedAt` es la fecha del estado vigente, es decir, la del último cambio. Los pedidos de M04 (PAGADO con `paid_at`) las cumplen sin migrar datos.
- **Sólo lectura (RN-22):** no existe ninguna ruta de cliente para modificar o cancelar pedidos.
- **Respuestas sensibles:** `Cache-Control: no-store` y `Pragma: no-cache` en todas las respuestas de Commerce.

### Límites de M05

- Las transiciones de estado las registrará el administrador en M06. En M05, CA-M05-04 se verifica con transiciones simuladas en las pruebas (`simulateAdminTransition`); su validación integral queda para M06.
- `ACCESS_DENIED` permanece en la outbox; la entrega a `audit-service` y la consulta de auditoría corresponden a M07.
- La respuesta 404 es idéntica en contenido, pero el caso de pedido ajeno hace una consulta y una escritura adicionales; la diferencia de tiempo no se mitiga en M05.

## Demostración del MVP

Con el stack levantado (`docker compose up -d --build --wait`), todo el recorrido se hace desde <http://127.0.0.1:5173>, sin Postman ni SQL:

1. **Registro** (`#/registro`): datos sintéticos, contraseña de 12+ caracteres → «Continuar a iniciar sesión».
2. **Login** (`#/login`): la cabecera muestra el nombre, «Carrito» y «Mis pedidos».
3. **Catálogo** (`#/`): búsqueda, filtro por categoría y paginación → **detalle** de un producto.
4. **Carrito**: «Agregar al carrito» en el detalle; en `#/carrito` cambiar la cantidad o eliminar líneas (total calculado en servidor).
5. **Checkout** (`#/checkout`): datos de entrega ficticios y pago **simulado** (aprobar o rechazar). Un rechazo conserva el carrito y no reserva stock.
6. **Confirmación** (`#/checkout/confirmacion/<id>`) → «Ver seguimiento del pedido» → **Mis pedidos** (`#/pedidos`).
7. **Inventario**: un producto en «Últimas unidades» (p. ej., Soporte Atlas, 3 unidades en el seed) pasa a «Agotado» al comprar todas sus unidades. La API pública solo expone disponibilidad cualitativa, no cantidades.
8. **Auditoría**: cada paso deja eventos en las outbox de Identity (`AUTH_REGISTER`, `AUTH_LOGIN_SUCCESS`, `AUTH_LOGOUT`) y Commerce (`ORDER_CREATED`, `PAYMENT_SIMULATED_REJECTED`). Su entrega a `audit-service` y su consulta son de M07; hoy solo pueden verse por lectura de la base.

La compra modifica datos (usuario, pedido, stock). Para ensayar sin tocar la base de desarrollo, use un proyecto Compose aparte con su propio volumen y credenciales efímeras, y publique sus puertos en otros números con un archivo de override fuera del repositorio. Contra ese stack, `scripts/mvp-e2e-smoke.mjs` recorre el mismo flujo por HTTP como lo haría el navegador (Origin, cookies, CSRF e `Idempotency-Key`, incluido el reintento con la misma clave). No tiene URLs por defecto, para que nunca escriba en el stack principal por accidente:

```bash
SPECTRA_E2E_IDENTITY_URL=http://127.0.0.1:13001 \
SPECTRA_E2E_CATALOG_URL=http://127.0.0.1:13002 \
SPECTRA_E2E_COMMERCE_URL=http://127.0.0.1:13003 \
node scripts/mvp-e2e-smoke.mjs
```

Consulte [CONTRIBUTING.md](CONTRIBUTING.md) y [SECURITY.md](SECURITY.md) antes de proponer cambios.
