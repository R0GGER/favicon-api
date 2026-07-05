FROM node:22-alpine AS deps
WORKDIR /app
# Build toolchain is only needed when prebuilt native binaries are unavailable
# for the current arch (e.g. better-sqlite3 on alpine/musl). It is dropped
# entirely in the final runtime image below.
RUN apk add --no-cache --virtual .build-deps python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && apk del .build-deps

FROM node:22-alpine
WORKDIR /app
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
EXPOSE 3000
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "--dns-result-order=ipv4first", "src/cluster.js"]
