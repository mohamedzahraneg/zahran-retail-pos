# =============================================================================
#  Zahran Retail Backend — Multi-stage Dockerfile
# =============================================================================

# ---- Stage 1: dependencies & build ----
FROM node:25-alpine AS builder

WORKDIR /app

# Install build tools for bcrypt
RUN apk add --no-cache python3 make g++

COPY package*.json ./
# Use npm install (not ci) since lockfile may be missing on first build
RUN npm install --no-audit --no-fund --legacy-peer-deps

COPY tsconfig*.json nest-cli.json ./
COPY src ./src

RUN npm run build && npm prune --production


# ---- Stage 2: runtime ----
FROM node:25-alpine AS runtime

ENV NODE_ENV=production \
    TZ=Africa/Cairo \
    PORT=3000

WORKDIR /app

RUN apk add --no-cache tini curl tzdata && \
    cp /usr/share/zoneinfo/Africa/Cairo /etc/localtime && \
    echo "Africa/Cairo" > /etc/timezone && \
    addgroup -g 1001 -S zahran && \
    adduser  -u 1001 -S zahran -G zahran

COPY --from=builder --chown=zahran:zahran /app/node_modules ./node_modules
COPY --from=builder --chown=zahran:zahran /app/dist ./dist
COPY --from=builder --chown=zahran:zahran /app/package.json ./package.json

# Create writable uploads dir for product images (bootstrap needs this)
RUN mkdir -p /app/uploads && chown -R zahran:zahran /app/uploads /app

USER zahran

EXPOSE 3000

HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=5 \
  CMD curl -fs http://localhost:3000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
