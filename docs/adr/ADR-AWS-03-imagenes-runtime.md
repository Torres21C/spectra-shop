# ADR-AWS-03 — Imágenes de ejecución sin dependencias de desarrollo e imagen de migración separada

- **Estado:** propuesta (pendiente de aprobación del propietario). Implementada en la rama local `feature/aws-pr3-runtime-images`.
- **Fecha:** 2026-11-20
- **Hallazgos:** AWS-07 (excepción de picomatch incompatible con AWS) y AWS-08 (imágenes con devDependencies) del [diagnóstico AWS](../operacion-y-aws/03-diagnostico-aws.md).

## Contexto

La etapa final de los Dockerfiles de los cuatro backends copiaba el `node_modules` completo del monorepo: Prisma CLI, TypeScript, Vite, Vitest, Supertest y **picomatch 4.0.7** (GHSA-fc5q-39xc-vjpf). La excepción SCA que cubre picomatch es válida «solo para el MVP académico local» y excluye AWS de forma expresa. Los jobs `*-migrate` dependían de ese contenido, porque ejecutan `prisma migrate deploy` desde la imagen de ejecución.

## Decisiones

1. **D-AWS-03-01. Cuatro etapas por servicio.**
   - `build`: sin cambios. La usan las pruebas `*-test`.
   - `prod-deps`: `npm ci --omit=dev --omit=optional --workspace <servicio> --include-workspace-root=false`. Solo instala las dependencias de producción del servicio, ni las de otros workspaces ni las de la raíz.
   - `migrate` (con `migrate-deps`): producción más las devDependencies del propio servicio (Prisma CLI) y los motores de Prisma ya descargados en `build`, con `CHECKPOINT_DISABLE=1`. Es la imagen de los jobs `*-migrate` en Compose (`target: migrate`) y de las tareas `run-task` en AWS.
   - `runtime`: etapa **final y objetivo por defecto**. Contiene `node_modules` de producción, `dist`, `prisma/` y el cliente Prisma generado.
2. **D-AWS-03-02. `--omit=optional`.** En el lockfile, `prisma` y `typescript` figuran como `devOptional`: son peers opcionales de `@prisma/client`, y `--omit=dev` no los excluye (ni `--omit=peer`, probado). Las únicas dependencias opcionales fuera de desarrollo son el CLI de Prisma y sus paquetes internos, `jiti` y `typescript`.
3. **D-AWS-03-03. Migraciones sin Internet.** La imagen `migrate` incluye el _schema engine_. Se comprobó que `prisma version` lo resuelve con `--network none`, condición necesaria en una VPC sin NAT (AD-05).
4. **D-AWS-03-04. La Web no cambia.** Su imagen (`vite preview`) sigue siendo solo para el entorno local; en AWS la SPA se publica en S3 + CloudFront. La excepción de picomatch sigue cubriendo las herramientas de desarrollo, la CI y esa imagen local. **No se modifica `.dependency-check/suppressions.xml`**: ampliar, retirar o reformular la excepción requiere la decisión del propietario.

## Consecuencias

- Imágenes de ejecución medidas en local (arm64): de ~792 MB a 386–435 MB; `node_modules` de ~250 MB a 87–139 MB. Ninguna contiene `prisma`, `typescript`, `vite`, `vitest`, `supertest`, `jiti`, `@prisma/engines` ni `picomatch`.
- El ECR tendrá dos imágenes por servicio (`runtime` y `migrate`), o dos etiquetas del mismo repositorio.
- Cada imagen ejecuta tres `npm ci` en el build (más tiempo de CI; la caché de capas lo mitiga).
- La imagen `migrate` sigue teniendo devDependencies del servicio (Prisma CLI y utilidades de prueba), pero no las de la raíz (sin Vite, Vitest ni picomatch). Se ejecuta de forma puntual y nunca recibe tráfico.
