FROM node:22-slim AS build
WORKDIR /app
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
RUN useradd --uid 10001 --create-home temperance
COPY --from=build --chown=temperance:temperance /app/.next/standalone ./
COPY --from=build --chown=temperance:temperance /app/.next/static ./.next/static
COPY --from=build --chown=temperance:temperance /app/public ./public
USER temperance
EXPOSE 3000
CMD ["node", "server.js"]
