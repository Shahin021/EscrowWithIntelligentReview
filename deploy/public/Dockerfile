# Build from the repository root, not from deploy/public.
FROM node:24-bookworm-slim AS frontend
WORKDIR /build/dapp
COPY dapp/package.json dapp/package-lock.json ./
RUN npm ci
COPY dapp/ ./
ENV VITE_AUTOMATION_URL=/api
RUN npm run build

FROM caddy:2-alpine AS web
COPY --from=frontend /build/dapp/dist /srv
COPY deploy/public/Caddyfile /etc/caddy/Caddyfile

FROM node:24-bookworm-slim AS service
WORKDIR /app/automation
COPY automation/package.json automation/package-lock.json ./
RUN npm ci --omit=dev
COPY automation/ ./
COPY dapp/src/ /app/dapp/src/
# Shared modules in /app/dapp/src import viem and genlayer-js; resolve them from
# the service's dependencies.
RUN ln -s /app/automation/node_modules /app/node_modules
# Source copied from a host with a restrictive umask (077) would be unreadable
# for the node user; make all code readable. No secrets are in the image.
RUN chmod -R a+rX /app/automation /app/dapp/src
RUN mkdir -p /data && chown node:node /data
ENV AUTOMATION_HOST=0.0.0.0 AUTOMATION_PORT=8790 AUTOMATION_DB=/data/automation.sqlite MAIL_OUTBOX_DIR=/data/outbox
USER node
EXPOSE 8790
CMD ["node", "--disable-warning=ExperimentalWarning", "bin/escrow-automation.js", "start"]
