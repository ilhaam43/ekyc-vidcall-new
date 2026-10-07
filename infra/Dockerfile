FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY ekyc-agent-frontend/package.json ./ekyc-agent-frontend/package.json
COPY ekyc-backend-master/package.json ./ekyc-backend-master/package.json
COPY ekyc-vidcall-backend/package.json ./ekyc-vidcall-backend/package.json
COPY ekyc-dashboard-new/package.json ./ekyc-dashboard-new/package.json
COPY kong-console/package.json ./kong-console/package.json
RUN npm ci --ignore-scripts
COPY . .

FROM dependencies AS build
ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=$VITE_BASE_PATH
RUN npm run build

FROM node:24-bookworm-slim AS backend-base
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

FROM backend-base AS backend
WORKDIR /app
COPY --from=dependencies /app /app
RUN npm prune --omit=dev --ignore-scripts
USER node
CMD ["node", "ekyc-vidcall-backend/src/server.js"]

FROM dependencies AS dashboard
RUN npm run build -w @ekyc/dashboard
RUN npm prune --omit=dev --ignore-scripts
USER node
CMD ["node", "ekyc-dashboard-new/server/index.js"]

FROM dependencies AS kong-console
RUN npm prune --omit=dev --ignore-scripts
USER node
CMD ["node", "kong-console/server.js"]

FROM nginxinc/nginx-unprivileged:1.28-alpine AS frontend
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/ekyc-agent-frontend/dist /usr/share/nginx/html
