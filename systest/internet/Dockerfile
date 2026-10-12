# A tiny fake internet: one DNS resolver and a web server per site, each on its own address.
FROM alpine:3.22
RUN apk add --no-cache dnsmasq busybox-extras iproute2
COPY start.sh /start.sh
ENTRYPOINT ["sh", "/start.sh"]
