FROM node:24-alpine AS build
WORKDIR /app/backend
COPY backend/package.json backend/yarn.lock* ./
RUN corepack enable && yarn install --frozen-lockfile
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN yarn build

FROM node:24-alpine AS runtime
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
