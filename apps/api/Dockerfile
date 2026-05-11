# =============================================================================
# Clean Connect API — Multi-stage Dockerfile
# -----------------------------------------------------------------------------
# Stages :
#   1. deps        — install monorepo
#   2. builder     — generate Prisma client + build NestJS
#   3. production  — image minimale node:20-alpine + dist + node_modules prod
# =============================================================================

ARG NODE_VERSION=20.18.0
ARG PNPM_VERSION=9.12.3

# -----------------------------------------------------------------------------
# 1. deps — installe toutes les deps du monorepo
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
RUN apk add --no-cache libc6-compat openssl
WORKDIR /repo

# corepack embarqué dans node:20.18-alpine a des clés pnpm obsolètes
# (Cannot find matching keyid) — on upgrade corepack avant activation.
RUN npm install -g corepack@latest \
 && corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/design-tokens/package.json ./packages/design-tokens/
COPY packages/eslint-config/package.json ./packages/eslint-config/

RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# 2. builder — génère Prisma client puis build NestJS
# -----------------------------------------------------------------------------
FROM deps AS builder
WORKDIR /repo
COPY . .
RUN pnpm --filter @cc/api run db:generate
RUN pnpm --filter @cc/api run build

# -----------------------------------------------------------------------------
# 3. production — image minimale
# -----------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS production
RUN apk add --no-cache openssl tini
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

RUN npm install -g corepack@latest \
 && corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate

COPY --from=builder /repo/apps/api/dist ./dist
COPY --from=builder /repo/apps/api/package.json ./package.json
COPY --from=builder /repo/apps/api/prisma ./prisma
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages ./node_modules/_workspace_packages

RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/readyz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
