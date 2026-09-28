# syntax=docker/dockerfile:1

# One image for both Railway services: api (`node dist/main.js`) and
# worker (`node dist/main.worker.js`). Migrations run as the release step:
# `npx prisma migrate deploy`. Node runs as PID 1; enableShutdownHooks()
# handles SIGTERM, so no init process is needed.

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npx prisma generate \
  && npm run build \
  && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/prisma.config.ts ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node i18n ./i18n
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
