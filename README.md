# SPECTRA Shop

Aplicación académica de comercio electrónico cloud-native. El código vive en este monorepo y la documentación académica se conserva en la bóveda Obsidian.

## Estado

Incremento 1 en desarrollo sobre `feature/m01-catalogo`: M01 Catálogo implementa persistencia PostgreSQL con Prisma, API NestJS documentada y una interfaz React funcional. No existe despliegue en AWS ni integración con pagos reales.

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

La migración y el seed sintético se ejecutan de forma idempotente al iniciar `catalog-service`. PostgreSQL no publica su puerto al host.

## Comandos

```bash
npm run lint
npm run typecheck
npm test
npm run test:cov
npm run build
docker compose --profile test run --rm catalog-test
```

La última orden ejecuta las pruebas de integración del catálogo contra PostgreSQL dentro de la red privada de Compose.

## API M01

| Método | Ruta                                                   | Función                                     |
| ------ | ------------------------------------------------------ | ------------------------------------------- |
| `GET`  | `/categories`                                          | Categorías activas para el filtro           |
| `GET`  | `/products?page=1&search=teclado&category=perifericos` | Listado paginado, búsqueda literal y filtro |
| `GET`  | `/products/:id`                                        | Detalle uniforme de un producto activo      |

El tamaño de página es 12 y lo controla el servidor. La API nunca expone el stock exacto: responde `OUT_OF_STOCK`, `LOW_STOCK` o `AVAILABLE`.

Consulte [CONTRIBUTING.md](CONTRIBUTING.md) y [SECURITY.md](SECURITY.md) antes de proponer cambios.
