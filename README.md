# SPECTRA Shop

Aplicación académica de comercio electrónico cloud-native. El código vive en este monorepo y la documentación académica se conserva en la bóveda Obsidian.

## Estado

M01 Catálogo y M02 Identidad están integrados en `main`. El Incremento 3 se desarrolla en `feature/m03-carrito`: M03 incorpora un carrito persistente por cliente, cálculo monetario en el servidor, revalidación contra Catalog y autorización apoyada en Identity. No existe despliegue en AWS ni integración con pagos reales.

## Arquitectura

- `apps/web`: React + Vite.
- `apps/identity-service`: identidad y sesiones.
- `apps/catalog-service`: catálogo e inventario.
- `apps/commerce-service`: carrito, checkout simulado y pedidos.
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

# Genere el token interno fuera del repositorio y copie el valor únicamente a .env.
openssl rand -hex 32

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
- API de carrito: <http://127.0.0.1:3003/cart>;
- Swagger de Commerce: <http://127.0.0.1:3003/docs>.

Las migraciones y seeds se ejecutan de forma idempotente al iniciar los servicios. PostgreSQL no publica su puerto al host. Las claves ES256 y la credencial interna se suministran desde rutas o variables locales no versionadas. Los listeners internos de Catalog (`3102`) e Identity (`3101`) sólo existen en la red privada de Compose y no se publican al host.

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
```

Las tres últimas órdenes ejecutan las pruebas de integración contra PostgreSQL dentro de la red privada de Compose. `identity-test` levanta un servidor HTTPS local con un certificado efímero y comprueba cookies `Secure` reales. `commerce-test` usa comunicación HTTP real entre Commerce, Catalog e Identity; las claves y el token interno siguen siendo obligatorios.

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

Sólo el rol `CLIENTE` puede usar estas rutas. Las mutaciones requieren cookie de sesión, token CSRF y `Origin` permitido. El servidor rechaza campos no declarados y calcula en GTQ con `Decimal`, redondeo `HALF_UP` y dos decimales. Una indisponibilidad de Catalog o Identity produce `503`; no se usan precios ni totales obsoletos. El checkout se muestra deshabilitado hasta M04.

La comunicación interna usa un token aleatorio de al menos 32 caracteres comparado en tiempo constante. `SPECTRA_INTERNAL_TOKENS` acepta el token actual y el anterior durante una rotación; Commerce envía sólo el actual. En una futura implantación AWS, la interfaz de configuración permitirá obtener la credencial desde Secrets Manager y las claves ES256 desde KMS, sin que M03 despliegue ni consuma esos servicios.

### Límite de M03

M03 no reserva stock ni crea pedidos. La ERS solicita una transacción ACID para la compra, mientras que la arquitectura distribuida contempla una saga entre Commerce y Catalog para M04. Esa contradicción sigue pendiente de resolución formal antes de implementar checkout. Completar M03 no completa las Fases 3 ni 4.

Consulte [CONTRIBUTING.md](CONTRIBUTING.md) y [SECURITY.md](SECURITY.md) antes de proponer cambios.
