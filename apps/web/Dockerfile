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
COPY apps/web apps/web
COPY packages/contracts packages/contracts
RUN npm run build --workspace @spectra/contracts && npm run build --workspace @spectra/web

FROM node:22.14.0-alpine3.21@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944
ENV NODE_ENV=production
WORKDIR /app
USER node
COPY --from=build --chown=node:node /workspace/node_modules /app/node_modules
COPY --from=build --chown=node:node /workspace/apps/web/dist /app/dist
EXPOSE 5173
CMD ["node", "node_modules/vite/bin/vite.js", "preview", "--host", "0.0.0.0", "--port", "5173"]
