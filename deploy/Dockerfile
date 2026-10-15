# The gateway add-on links against glibc: build it on the same Debian release as the runtime.
FROM rust:1-slim-bookworm AS gateway
WORKDIR /src
COPY core/ core/
COPY specs/ specs/
RUN cd core && cargo build --release -p temperance-gateway --features node --lib

FROM node:24-bookworm-slim AS build
ARG TEMPERANCE_VERSION=dev
WORKDIR /app/web
COPY web/package*.json ./
COPY web/gateway-addon/ ./gateway-addon/
RUN npm ci
COPY web/ ./
COPY specs/ /app/specs/
COPY scripts/ /app/scripts/
COPY --from=gateway /src/core/target/release/libtemperance_gateway.so ./gateway-addon/
RUN mv gateway-addon/libtemperance_gateway.so \
      "gateway-addon/temperance-gateway.$(node -p 'process.platform + "-" + process.arch').node" \
  && TEMPERANCE_VERSION="$TEMPERANCE_VERSION" npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 TEMPERANCE_DATA_DIR=/data TEMPERANCE_INSTALL=docker
RUN useradd --uid 10001 --create-home temperance \
  && install -d -o temperance -g temperance -m 700 /data
COPY --from=build --chown=temperance:temperance /app/web/.next/standalone ./
COPY --from=build --chown=temperance:temperance /app/web/.next/static ./.next/static
COPY --from=build --chown=temperance:temperance /app/web/scripts/recovery.cjs ./scripts/recovery.cjs
COPY --from=build --chown=temperance:temperance /app/web/scripts/acceptance.mjs ./scripts/acceptance.mjs
USER temperance
VOLUME /data
EXPOSE 3000 51820/udp
CMD ["node", "server.js"]
