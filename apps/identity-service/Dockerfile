FROM node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS build
WORKDIR /workspace
RUN apk add --no-cache openssl
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
COPY apps/identity-service apps/identity-service
COPY packages/contracts packages/contracts
RUN npm run prisma:generate --workspace @spectra/identity-service && npm run build --workspace @spectra/contracts && npm run build --workspace @spectra/identity-service

# AWS-08: dependencias de PRODUCCIÓN de este servicio únicamente (sin devDependencies ni otros
# workspaces). Así la imagen de ejecución no contiene Prisma CLI, Vite, Vitest ni picomatch (AWS-07).
# --omit=optional: `prisma` y `typescript` son peers opcionales de @prisma/client («devOptional» en
# el lockfile) y npm los instalaría con solo --omit=dev. No hay otras dependencias opcionales de producción.
FROM node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS prod-deps
WORKDIR /workspace
RUN npm install --global npm@11.19.0
COPY package*.json ./
COPY apps/identity-service/package.json apps/identity-service/package.json
COPY apps/catalog-service/package.json apps/catalog-service/package.json
COPY apps/commerce-service/package.json apps/commerce-service/package.json
COPY apps/audit-service/package.json apps/audit-service/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --omit=dev --omit=optional --workspace @spectra/identity-service --include-workspace-root=false

# DT-09: dependencias de migración (producción + devDependencies del propio servicio, p. ej. Prisma CLI).
FROM node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS migrate-deps
WORKDIR /workspace
RUN npm install --global npm@11.19.0
COPY package*.json ./
COPY apps/identity-service/package.json apps/identity-service/package.json
COPY apps/catalog-service/package.json apps/catalog-service/package.json
COPY apps/commerce-service/package.json apps/commerce-service/package.json
COPY apps/audit-service/package.json apps/audit-service/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --workspace @spectra/identity-service --include-workspace-root=false

# Imagen de los jobs `*-migrate` (Compose: target migrate; AWS: tarea run-task). No arranca el servicio.
FROM node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS migrate
# R-PR6-10: sin gestores de paquetes en la imagen final. La aplicación y las migraciones solo usan `node` y
# `./node_modules/.bin/prisma` (Compose y ECS); nunca npm, npx, corepack ni yarn. Los archivos quedan ocultos
# por esta capa (no accesibles en el contenedor) aunque sigan en la capa de la imagen base.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production
# Sin salida a Internet en AWS: Prisma no debe intentar comprobar versiones ni telemetría.
ENV CHECKPOINT_DISABLE=1
WORKDIR /app
USER node
COPY --from=migrate-deps --chown=node:node /workspace/node_modules /app/node_modules
COPY --from=build --chown=node:node /workspace/node_modules/@prisma/engines /app/node_modules/@prisma/engines
COPY --from=build --chown=node:node /workspace/apps/identity-service/dist /app/dist
COPY --from=build --chown=node:node /workspace/apps/identity-service/prisma /app/prisma
COPY --from=build --chown=node:node /workspace/apps/identity-service/src/generated/identity-client /app/dist/generated/identity-client

# Imagen de ejecución (etapa final: objetivo por defecto).
FROM node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS runtime
# R-PR6-10: sin gestores de paquetes en la imagen final. La aplicación y las migraciones solo usan `node` y
# `./node_modules/.bin/prisma` (Compose y ECS); nunca npm, npx, corepack ni yarn. Los archivos quedan ocultos
# por esta capa (no accesibles en el contenedor) aunque sigan en la capa de la imagen base.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production
WORKDIR /app
USER node
COPY --from=prod-deps --chown=node:node /workspace/node_modules /app/node_modules
COPY --from=build --chown=node:node /workspace/apps/identity-service/dist /app/dist
COPY --from=build --chown=node:node /workspace/apps/identity-service/prisma /app/prisma
COPY --from=build --chown=node:node /workspace/apps/identity-service/src/generated/identity-client /app/dist/generated/identity-client
EXPOSE 3001
# DT-09: el contenedor de ejecución no migra ni siembra; lo hace el job `identity-migrate` (target migrate).
CMD ["node", "dist/main.js"]
