# syntax=docker/dockerfile:1
# Hand-built implementation image. It runs the API, the worker (ROLE) and the fake services (see compose).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/parity/package.json packages/parity/
COPY packages/handbuilt/package.json packages/handbuilt/
RUN npm ci --include-workspace-root -w @policy/domain -w @policy/parity -w @policy/handbuilt
COPY packages/domain/tsconfig.json packages/domain/
COPY packages/domain/src packages/domain/src
COPY packages/parity/tsconfig.json packages/parity/
COPY packages/parity/src packages/parity/src
COPY packages/handbuilt/tsconfig.json packages/handbuilt/
COPY packages/handbuilt/src packages/handbuilt/src
# Tests are not in the build context; compile only the sources.
RUN sed -i 's#"include": \["src", "test"\]#"include": ["src"]#' packages/handbuilt/tsconfig.json \
  && npx tsc -b packages/handbuilt \
  && npm prune --omit=dev --include-workspace-root -w @policy/domain -w @policy/handbuilt

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/domain/package.json ./packages/domain/
COPY --from=build /app/packages/domain/dist/src ./packages/domain/dist/src
COPY --from=build /app/packages/handbuilt/package.json ./packages/handbuilt/
COPY --from=build /app/packages/handbuilt/dist/src ./packages/handbuilt/dist/src
USER node
EXPOSE 3000
CMD ["node", "packages/handbuilt/dist/src/main.js"]
