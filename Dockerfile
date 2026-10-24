FROM node:24.22.1-trixie-slim AS build
WORKDIR /app
RUN npm install --global --ignore-scripts pnpm@12.9.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
ARG SENTRY_RELEASE
# The Sentry token arrives as a build secret (cloudbuild.yaml), so it never lands in a layer. Without
# it the build still succeeds and simply skips the source-map upload.
RUN --mount=type=secret,id=sentry_auth_token \
    if [ -s /run/secrets/sentry_auth_token ]; then \
      export SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token)" SENTRY_UPLOAD_SOURCEMAPS=true; \
    fi; \
    SENTRY_RELEASE="$SENTRY_RELEASE" pnpm build && pnpm prune --prod --ignore-scripts

# Static ffmpeg/ffprobe: the Debian ffmpeg package drags in hundreds of MB of shared libraries.
FROM mwader/static-ffmpeg:9.0.2@sha256:7d9bdaaf887f7e6ce6151f67325c344074b5ff1fb75316011c3376503e449a7b AS ffmpeg

# Distroless: no shell or package manager, smallest Node 24 runtime, non-root by default.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:78f07ef1b5ea71ad7c055df15d0dd8997f2d288f9158623c4d4ae3d765b7d50d
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
# Root-owned on purpose: the nonroot user can read and execute the app but never rewrite it.
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
USER nonroot
EXPOSE 8080
CMD ["build"]
