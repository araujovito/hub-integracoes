FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS build
WORKDIR /app/backend
COPY backend/package.json backend/yarn.lock* ./
RUN corepack enable && yarn install --frozen-lockfile
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN yarn build

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS runtime
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
