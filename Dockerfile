# App container: SvelteKit (adapter-node) + ffmpeg. The model runs in its own sidecar container.

FROM node:24.21.0-trixie-slim AS build
WORKDIR /app
RUN npm install --global --ignore-scripts pnpm@12.9.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build && pnpm prune --prod --ignore-scripts

FROM node:24.21.0-trixie-slim AS runtime
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build --chown=node:node --chmod=555 /app/build ./build
COPY --from=build --chown=node:node --chmod=555 /app/node_modules ./node_modules
COPY --from=build --chown=node:node --chmod=444 /app/package.json ./package.json
USER node
EXPOSE 8080
CMD ["node", "build"]
