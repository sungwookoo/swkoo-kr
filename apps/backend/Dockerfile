# syntax=docker/dockerfile:1.6

# Storage helpers use only Python's standard library; omit package managers
# and their unused bundled dependencies from this privileged infrastructure image.
FROM python:3.13-alpine@sha256:8bcfa47b04b853a17aaf909362b847b2112fd6ec4105ea553ef9a43bafbb5916 AS storage-helper
RUN rm -rf /usr/local/lib/python3.13/site-packages /usr/local/lib/python3.13/ensurepip \
  && rm -f /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.13
ENV PYTHONDONTWRITEBYTECODE=1

# Keep upstream provisioning behavior, with patched Go/toolchain dependencies.
FROM golang:1.27.3-alpine@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb AS storage-provisioner-build
WORKDIR /src
ENV CGO_ENABLED=0 GOMAXPROCS=2 GOTOOLCHAIN=local GOFLAGS=-mod=mod
ADD --checksum=sha256:2b95efae90cd01de97dd9809739d24b0ad2ccaded6e86e308f71733b690b3de8 https://codeload.github.com/rancher/local-path-provisioner/tar.gz/49b2be8e26d6d34c9afaa21fa33108d2e82f8955 /tmp/source.tar.gz
RUN tar -xzf /tmp/source.tar.gz --strip-components=1 -C /src \
  && go get github.com/klauspost/compress@v1.18.7 golang.org/x/net@v0.60.0 golang.org/x/text@v0.42.0 \
  && go mod tidy \
  && go test ./... \
  && go build -trimpath -buildvcs=false -ldflags="-s -w -X main.VERSION=v0.0.37-swkoo.1" -o /out/local-path-provisioner .

FROM scratch AS storage-provisioner
ENV PATH=/usr/local/bin
COPY --from=storage-helper /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=storage-provisioner-build /out/local-path-provisioner /usr/local/bin/local-path-provisioner
COPY --from=storage-provisioner-build /src/LICENSE /licenses/local-path-provisioner-LICENSE
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/local-path-provisioner"]

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
ARG BUILD_REVISION
ENV BUILD_REVISION=${BUILD_REVISION}
WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package*.json ./

RUN addgroup -S app && adduser -S app -G app \
  && chown -R app:app /app

USER app

EXPOSE 3000
CMD ["node", "dist/main.js"]
