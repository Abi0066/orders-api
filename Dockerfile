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

# npm/npx are build-time tools. Keeping them in the runtime image drags in their
# own dependency tree (sigstore, picomatch, ...) which is pure vulnerability
# surface for a container that only ever runs `node src/app.js` -- and it is what
# made the first Trivy run fail on packages the application does not even use.
# Must run while still root, before switching to the unprivileged user.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER node
EXPOSE 3000

# The image is identical for v1/v2/v3: behaviour is driven by APP_VERSION and
# FAIL_RATE, which the GitOps manifests set. Versions still get distinct tags so
# `kind load` and Rollouts can tell them apart.
CMD ["node", "src/app.js"]
