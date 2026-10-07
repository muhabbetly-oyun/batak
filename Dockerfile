# Iki paketi birden derler: once motor, sonra sunucu.
# Depo kokunden calistirilir:  docker compose build

FROM node:22-alpine AS build
WORKDIR /repo

# --- motor ---
COPY batak-engine/package.json batak-engine/tsconfig.json ./batak-engine/
RUN cd batak-engine && npm install --no-audit --no-fund
COPY batak-engine/src ./batak-engine/src
RUN cd batak-engine && npm run build

# --- sunucu ---
COPY game-server/package.json game-server/tsconfig.json ./game-server/
RUN cd game-server && npm install --no-audit --no-fund
COPY game-server/src ./game-server/src
RUN cd game-server && npx tsc -p tsconfig.json

FROM node:22-alpine AS deps
WORKDIR /repo
COPY batak-engine/package.json ./batak-engine/
COPY --from=build /repo/batak-engine/dist ./batak-engine/dist
COPY game-server/package.json ./game-server/
RUN cd game-server && npm install --omit=dev --no-audit --no-fund

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tini

COPY --from=deps  /repo/game-server/node_modules ./node_modules
COPY --from=deps  /repo/batak-engine            ./node_modules/@muhabbetly/batak-engine
COPY --from=build /repo/game-server/dist        ./dist
COPY game-server/package.json ./

# Panel ve istemci sunucu tarafindan servis edilir.
COPY batak-engine/admin/index.html ./admin/index.html
COPY client/index.html             ./client/index.html

USER node
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
