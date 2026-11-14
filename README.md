# SPECTRA Shop

Aplicación académica de comercio electrónico cloud-native. El código vive en este monorepo y la documentación académica se conserva en la bóveda Obsidian.

## Estado

M01 Catálogo está integrado en `main`. El Incremento 2 se desarrolla en `feature/m02-identidad`: M02 incorpora registro, login, logout, perfil propio, sesiones persistentes, JWT ES256, refresh token rotado y controles de seguridad. No existe despliegue en AWS ni integración con pagos reales.

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

Las migraciones y seeds se ejecutan de forma idempotente al iniciar catálogo e identidad. PostgreSQL no publica su puerto al host. El entorno Compose utiliza una clave ES256 efímera en memoria; una clave persistente debe configurarse mediante `IDENTITY_PRIVATE_KEY_PATH` e `IDENTITY_PUBLIC_KEY_PATH`, siempre fuera del repositorio.

## Comandos

```bash
npm run lint
npm run typecheck
npm test
npm run test:cov
npm run build
docker compose --profile test run --rm catalog-test
docker compose --profile test run --rm identity-test
```

Las dos últimas órdenes ejecutan las pruebas de integración contra PostgreSQL dentro de la red privada de Compose. `identity-test` levanta un servidor HTTPS local con un certificado efímero y comprueba cookies `Secure` reales.

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

La revocación inmediata sólo está implementada dentro de identidad. Los demás microservicios podrán aceptar un access token ya emitido durante un máximo de 15 minutos hasta incorporar distribución de revocaciones. MFA, recuperación y verificación de correo continúan fuera del alcance de M02.

Consulte [CONTRIBUTING.md](CONTRIBUTING.md) y [SECURITY.md](SECURITY.md) antes de proponer cambios.
