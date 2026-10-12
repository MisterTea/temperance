// Terminates TLS with a throwaway certificate and forwards to the local Next.js server.
// usage: node https-proxy.mjs <cert.pem> <key.pem> <listen port> <target port>
import { readFileSync } from "node:fs";
import https from "node:https";
import http from "node:http";

const [cert, key, listen, target] = process.argv.slice(2);
https
  .createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
    const upstream = http.request(
      { host: "127.0.0.1", port: Number(target), path: req.url, method: req.method, headers: req.headers },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  })
  .listen(Number(listen), "127.0.0.1");
