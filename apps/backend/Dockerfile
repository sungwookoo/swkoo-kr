# syntax=docker/dockerfile:1.6

# Keep native addon build headers and runtime aligned. Node 24.19+ has an
# ObjectWrap cleanup regression: https://github.com/nodejs/node/issues/65446
FROM node:24.18.1-alpine AS base
WORKDIR /app
# Build tools for native modules whose prebuilts don't cover the Node 24 +
# musl + arm64 combo (notably better-sqlite3). Only kept in the intermediate
# stages — the final runner uses the same pinned Node version.
RUN apk add --no-cache python3 make g++

FROM base AS deps
COPY package*.json ./
RUN npm ci

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS prod-deps
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:24.18.1-alpine AS runner
# Runtime does not install packages; omit bundled package-manager dependencies.
RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules/npm /opt/yarn-* \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production
WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package*.json ./

RUN addgroup -S app && adduser -S app -G app \
  && chown -R app:app /app

USER app

EXPOSE 3000
CMD ["node", "dist/main.js"]
