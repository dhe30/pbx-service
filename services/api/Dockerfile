# PBX API image (optional: the Ansible `api` role runs the same build directly under systemd).
# Build from the REPO ROOT (npm workspaces):
#   docker build -f services/api/Dockerfile -t pbx-api .
#   docker run --env-file .env -p 3000:3000 -e HOST=0.0.0.0 pbx-api
# Config is environment only (services/api/src/config.ts).

# ---- build: compile @pbx/shared and @pbx/api -----------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /src
# argon2 ships prebuilt binaries; these are only needed if it has to compile from source.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
# Every workspace's package.json must exist for `npm ci` to accept the lockfile.
COPY package.json package-lock.json ./
COPY services/shared/package.json services/shared/
COPY services/api/package.json services/api/
COPY services/ari-app/package.json services/ari-app/
COPY services/web/package.json services/web/
RUN npm ci --no-audit --no-fund -w @pbx/shared -w @pbx/api
COPY tsconfig*.json ./
COPY services/shared services/shared
COPY services/api services/api
RUN npm run build -w @pbx/shared -w @pbx/api \
 && npm prune --omit=dev -w @pbx/shared -w @pbx/api

# ---- runtime ------------------------------------------------------------------------------------
FROM node:24-bookworm-slim
# ffmpeg converts uploaded greetings to 8 kHz mono WAV (POST /media).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules node_modules
COPY --from=build /src/services/shared/package.json services/shared/
COPY --from=build /src/services/shared/dist services/shared/dist
COPY --from=build /src/services/api/package.json services/api/
COPY --from=build /src/services/api/dist services/api/dist
WORKDIR /app/services/api
USER node
EXPOSE 3000
# SIGTERM -> /ready 503 for SHUTDOWN_DRAIN_MS, then a clean exit (src/index.ts).
CMD ["node", "dist/index.js"]
