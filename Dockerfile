FROM node:24.21.0-trixie-slim AS build
WORKDIR /app
RUN npm install --global --ignore-scripts pnpm@12.9.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build && pnpm prune --prod --ignore-scripts

# Static ffmpeg/ffprobe: the Debian ffmpeg package drags in hundreds of MB of shared libraries.
FROM mwader/static-ffmpeg:9.0.2@sha256:7d9bdaaf887f7e6ce6151f67325c344074b5ff1fb75316011c3376503e449a7b AS ffmpeg

# Distroless: no shell or package manager, smallest Node 24 runtime, non-root by default.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
# Root-owned on purpose: the nonroot user can read and execute the app but never rewrite it.
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
EXPOSE 8080
CMD ["build"]
