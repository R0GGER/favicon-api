FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
RUN mkdir -p /cache && chown app:app /cache
USER app
ENV NODE_ENV=production
ENV CACHE_DIR=/cache
EXPOSE 3000
CMD ["node", "src/index.js"]
