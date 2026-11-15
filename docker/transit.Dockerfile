# syntax=docker/dockerfile:1

# Public transport routing: one image for two Railway services,
# "transit" (`node dist/scripts/transit-serve.js`, serves MOTIS on the
# private network) and "transit-builder" (cron, `node
# dist/scripts/transit-build.js`, builds the MOTIS data and uploads it to
# R2). See docs/deploy/transit.md. Build context: the repository root.

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

FROM debian:bookworm-slim AS motis
# MOTIS release binary (static), pinned by version and checksum.
ARG MOTIS_VERSION=2.11.4
ARG MOTIS_SHA256=b521bb29c961a3b994ff4dac663778ba64fee7b4cfaf3f2b20ff1d5e1d15e0dc
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl bzip2 \
  && curl -fsSL -o /tmp/motis.tar.bz2 \
    "https://github.com/motis-project/motis/releases/download/v${MOTIS_VERSION}/motis-linux-amd64.tar.bz2" \
  && echo "${MOTIS_SHA256}  /tmp/motis.tar.bz2" | sha256sum -c - \
  && mkdir /motis && tar -xjf /tmp/motis.tar.bz2 -C /motis ./motis

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
# osmium cuts each city's streets from its Geofabrik extract (builder).
RUN apt-get update \
  && apt-get install -y --no-install-recommends osmium-tool ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=motis /motis/motis /usr/local/bin/motis
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
ENV TRANSIT_WORK_DIR=/tmp/transit
EXPOSE 8080
CMD ["node", "dist/scripts/transit-serve.js"]
