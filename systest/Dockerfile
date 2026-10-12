# The headless client: the system test binary plus kernel WireGuard tools.
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY core/ core/
COPY specs/ specs/
COPY systest/ systest/
RUN cd systest && cargo test --release --locked --no-run \
  && cp "$(ls target/release/deps/system-* | grep -v '\.d$')" /systest

FROM debian:12-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends iproute2 wireguard-tools \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /systest /usr/local/bin/systest
ENV TEMPERANCE_SYSTEST=1
ENTRYPOINT ["systest", "--test-threads=1", "--nocapture"]
