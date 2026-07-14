# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY config ./config
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV SETTINGS_PATH=/app/config/settings.json

COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY config/media-classification-instructions.md config/metadata-fix-hint-instructions.md ./config/

USER node
CMD ["node", "dist/index.js"]
