FROM node:24.14.1-bookworm-slim AS build
WORKDIR /app
COPY backend/core/package.json backend/core/package-lock.json ./
RUN npm ci
COPY backend/core/tsconfig.json ./
COPY backend/core/src ./src
RUN npx tsc
RUN npm prune --omit=dev

FROM node:24.14.1-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/src/modules/provider-archive/schema.sql ./src/modules/provider-archive/schema.sql
USER node
CMD ["node", "dist/modules/provider-archive/cli.js", "serve"]
