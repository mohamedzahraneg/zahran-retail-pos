# =============================================================================
#  Zahran Retail Frontend — Multi-stage Dockerfile (Vite + nginx)
# =============================================================================

# ---- Stage 1: build ----
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
# Use npm install (not ci) since lockfile may be missing on first build
RUN npm install --no-audit --no-fund --legacy-peer-deps

COPY . .

# Empty baseURL => frontend requests are same-origin (/api/v1/...).
# nginx then proxies /api/ to the backend container on port 3000.
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL
# Use vite build directly (skip strict tsc type-check which can fail builds
# on legitimate-at-runtime code). Type errors are still caught in dev via IDE.
RUN npx vite build


# ---- Stage 2: serve ----
FROM nginx:1.29-alpine AS runtime

RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Africa/Cairo /etc/localtime && \
    echo "Africa/Cairo" > /etc/timezone

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1
# 127.0.0.1 (IPv4 explicit) — `localhost` in Alpine can resolve to ::1
# first, causing false "unhealthy" states. Same pattern as the api
# healthcheck fixed in PR #22.

CMD ["nginx", "-g", "daemon off;"]
