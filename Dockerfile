FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/dreamdex/package.json packages/dreamdex/package.json
COPY packages/evaluate/package.json packages/evaluate/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/chain/package.json packages/chain/package.json
COPY packages/metrics/package.json packages/metrics/package.json
COPY packages/observe/package.json packages/observe/package.json
COPY packages/policy-runtime/package.json packages/policy-runtime/package.json
COPY packages/settle/package.json packages/settle/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY . .
RUN find apps packages -name "*.tsbuildinfo" -delete
RUN pnpm build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S edgelab && adduser -S edgelab -G edgelab
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
COPY --from=build /app/evidence ./evidence
USER edgelab
EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]
