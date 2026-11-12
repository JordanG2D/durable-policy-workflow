# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/handbuilt/package.json packages/handbuilt/
RUN npm ci --include-workspace-root -w @policy/handbuilt
COPY packages/handbuilt/tsconfig.json packages/handbuilt/
COPY packages/handbuilt/src packages/handbuilt/src
RUN npx tsc -b packages/handbuilt && npm prune --omit=dev --include-workspace-root -w @policy/handbuilt

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/handbuilt/package.json ./packages/handbuilt/
COPY --from=build /app/packages/handbuilt/dist/src ./packages/handbuilt/dist/src
USER node
EXPOSE 3000
# The same image runs the API, the worker (ROLE) and the fake services (see compose).
CMD ["node", "packages/handbuilt/dist/src/main.js"]
