FROM node:22-alpine AS deps
WORKDIR /app
# Keep npm's "new version available" banner out of build logs and out of the
# output of `docker compose exec … npm run …`, where it buries the lines the
# operator has to copy.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
# Build toolchain is only needed when prebuilt native binaries are unavailable
# for the current arch (e.g. better-sqlite3 on alpine/musl). It is dropped
# entirely in the final runtime image below.
RUN apk add --no-cache --virtual .build-deps python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && apk del .build-deps

FROM node:22-alpine
WORKDIR /app
# fontconfig so librsvg can load a default fonts.conf (otherwise every SVG
# raster logs "Fontconfig error: Cannot load default config file").
RUN apk add --no-cache fontconfig
RUN addgroup -S app && adduser -S app -G app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY CHANGELOG.md ./
COPY src ./src
# scripts/ contains the API key management CLI invoked via
# `docker compose exec maflplus-favicon-api npm run keys:*`.
COPY scripts ./scripts
RUN mkdir -p /cache && chown app:app /cache
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN sed -i 's/\r$//' /docker-entrypoint.sh && chmod +x /docker-entrypoint.sh
USER app
ENV NODE_ENV=production
ENV CACHE_DIR=/cache
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
EXPOSE 3000
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "--dns-result-order=ipv4first", "src/cluster.js"]
