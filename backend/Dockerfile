FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS build
WORKDIR /app/backend
COPY backend/package.json backend/yarn.lock* ./
RUN corepack enable && yarn install --frozen-lockfile
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN yarn build

FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS runtime
ENV NODE_ENV=production
WORKDIR /app/backend
COPY backend/package.json backend/yarn.lock* ./
RUN corepack enable && yarn install --frozen-lockfile --production && npm cache clean --force
COPY --from=build /app/backend/dist ./dist
COPY db/migrations /app/db/migrations
COPY dashboard /app/dashboard
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
