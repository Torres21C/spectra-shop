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

FROM node:22.14.0-alpine3.21@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944
ENV NODE_ENV=production
WORKDIR /app
USER node
COPY --from=build --chown=node:node /workspace/node_modules /app/node_modules
COPY --from=build --chown=node:node /workspace/apps/catalog-service/dist /app/dist
COPY --from=build --chown=node:node /workspace/apps/catalog-service/prisma /app/prisma
EXPOSE 3002
# DT-09: el contenedor de ejecución no migra ni siembra; lo hace el job `catalog-migrate` con el rol migrador.
CMD ["node", "dist/main.js"]
