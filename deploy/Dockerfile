FROM node:24-slim AS build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
COPY specs/ /app/specs/
RUN npm run build

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
RUN useradd --uid 10001 --create-home temperance \
  && install -d -o temperance -g temperance /data
COPY --from=build --chown=temperance:temperance /app/web/.next/standalone ./
COPY --from=build --chown=temperance:temperance /app/web/.next/static ./.next/static
COPY --from=build --chown=temperance:temperance /app/web/public ./public
USER temperance
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
