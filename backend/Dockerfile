FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS build
WORKDIR /app/backend
COPY backend/package.json backend/yarn.lock* ./
RUN corepack enable && yarn install --frozen-lockfile
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN yarn build

FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS runtime
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
