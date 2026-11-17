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
RUN npm ci --ignore-scripts
COPY tsconfig.base.json ./
COPY apps/audit-service apps/audit-service
COPY packages/contracts packages/contracts
RUN npm run prisma:generate --workspace @spectra/audit-service && npm run build --workspace @spectra/contracts && npm run build --workspace @spectra/audit-service

FROM node:22.14.0-alpine3.21@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944
ENV NODE_ENV=production
WORKDIR /app
USER node
COPY --from=build --chown=node:node /workspace/node_modules /app/node_modules
COPY --from=build --chown=node:node /workspace/apps/audit-service/dist /app/dist
COPY --from=build --chown=node:node /workspace/apps/audit-service/prisma /app/prisma
COPY --from=build --chown=node:node /workspace/apps/audit-service/src/generated/audit-client /app/dist/generated/audit-client
EXPOSE 3004
# DT-09: el contenedor de ejecución no migra; lo hace el job `audit-migrate` con el rol migrador.
CMD ["node", "dist/main.js"]
