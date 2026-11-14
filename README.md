# SPECTRA Shop

Aplicación académica de comercio electrónico cloud-native. El código vive en este monorepo y la documentación académica se conserva en la bóveda Obsidian.

## Estado

Incremento 0 en desarrollo: fundación técnica, servicios con health checks y controles básicos de calidad. No existe despliegue en AWS ni integración con pagos reales.

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

## Comandos

```bash
npm run lint
npm run typecheck
npm test
npm run test:cov
npm run build
```

Consulte [CONTRIBUTING.md](CONTRIBUTING.md) y [SECURITY.md](SECURITY.md) antes de proponer cambios.
