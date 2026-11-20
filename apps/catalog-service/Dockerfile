FROM node:22.14.0-alpine3.21@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944 AS build
WORKDIR /workspace
RUN npm install --global npm@11.19.0
COPY package*.json ./
COPY apps/identity-service/package.json apps/identity-service/package.json
COPY apps/catalog-service/package.json apps/catalog-service/package.json
COPY apps/commerce-service/package.json apps/commerce-service/package.json
COPY apps/audit-service/package.json apps/audit-service/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci
COPY tsconfig.base.json ./
COPY apps/catalog-service apps/catalog-service
COPY packages/contracts packages/contracts
RUN npm run prisma:generate --workspace @spectra/catalog-service && npm run build --workspace @spectra/contracts && npm run build --workspace @spectra/catalog-service

# AWS-08: dependencias de PRODUCCIÓN de este servicio únicamente (sin devDependencies ni otros
# workspaces). Así la imagen de ejecución no contiene Prisma CLI, Vite, Vitest ni picomatch (AWS-07).
# --omit=optional: `prisma` y `typescript` son peers opcionales de @prisma/client («devOptional» en
# el lockfile) y npm los instalaría con solo --omit=dev. No hay otras dependencias opcionales de producción.
FROM node:22.14.0-alpine3.21@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944 AS prod-deps
WORKDIR /workspace
RUN npm install --global npm@11.19.0
COPY package*.json ./
COPY apps/identity-service/package.json apps/identity-service/package.json
COPY apps/catalog-service/package.json apps/catalog-service/package.json
COPY apps/commerce-service/package.json apps/commerce-service/package.json
COPY apps/audit-service/package.json apps/audit-service/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --omit=dev --omit=optional --workspace @spectra/catalog-service --include-workspace-root=false

# DT-09: dependencias de migración (producción + devDependencies del propio servicio, p. ej. Prisma CLI).
FROM node:22.14.0-alpine3.21@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944 AS migrate-deps
WORKDIR /workspace
RUN npm install --global npm@11.19.0
COPY package*.json ./
COPY apps/identity-service/package.json apps/identity-service/package.json
COPY apps/catalog-service/package.json apps/catalog-service/package.json
COPY apps/commerce-service/package.json apps/commerce-service/package.json
COPY apps/audit-service/package.json apps/audit-service/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --workspace @spectra/catalog-service --include-workspace-root=false

# Imagen de los jobs `*-migrate` (Compose: target migrate; AWS: tarea run-task). No arranca el servicio.
FROM node:22.14.0-alpine3.21@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944 AS migrate
ENV NODE_ENV=production
# Sin salida a Internet en AWS: Prisma no debe intentar comprobar versiones ni telemetría.
ENV CHECKPOINT_DISABLE=1
WORKDIR /app
USER node
COPY --from=migrate-deps --chown=node:node /workspace/node_modules /app/node_modules
COPY --from=build --chown=node:node /workspace/node_modules/@prisma/engines /app/node_modules/@prisma/engines
COPY --from=build --chown=node:node /workspace/apps/catalog-service/dist /app/dist
COPY --from=build --chown=node:node /workspace/apps/catalog-service/prisma /app/prisma
# Cliente Prisma por defecto (node_modules/.prisma): se genera en la etapa build.
COPY --from=build --chown=node:node /workspace/node_modules/.prisma /app/node_modules/.prisma

# Imagen de ejecución (etapa final: objetivo por defecto).
FROM node:22.14.0-alpine3.21@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944 AS runtime
ENV NODE_ENV=production
WORKDIR /app
USER node
COPY --from=prod-deps --chown=node:node /workspace/node_modules /app/node_modules
COPY --from=build --chown=node:node /workspace/apps/catalog-service/dist /app/dist
COPY --from=build --chown=node:node /workspace/apps/catalog-service/prisma /app/prisma
# Cliente Prisma por defecto (node_modules/.prisma): se genera en la etapa build.
COPY --from=build --chown=node:node /workspace/node_modules/.prisma /app/node_modules/.prisma
EXPOSE 3002
# DT-09: el contenedor de ejecución no migra ni siembra; lo hace el job `catalog-migrate` (target migrate).
CMD ["node", "dist/main.js"]
