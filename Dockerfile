# syntax=docker/dockerfile:1
# --- build stage: install production dependencies only -----------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# --- runtime stage -----------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

# node:alpine ships an unprivileged "node" user (uid 1000). Running as it is what
# lets the Rollout use runAsNonRoot + readOnlyRootFilesystem without extra setup.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

USER node
EXPOSE 3000

# The image is identical for v1/v2/v3: behaviour is driven by APP_VERSION and
# FAIL_RATE, which the GitOps manifests set. Versions still get distinct tags so
# `kind load` and Rollouts can tell them apart.
CMD ["node", "src/app.js"]
