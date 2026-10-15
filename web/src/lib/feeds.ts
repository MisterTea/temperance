import { z } from "zod";
import { mutate, type Repository } from "./database";
import { CATALOG, normalizeDomain } from "./policy";
import type { State } from "./model";

const configuration = z
  .array(
    z.object({
      category: z.enum(
        Object.keys(CATALOG) as [
          keyof typeof CATALOG,
          ...(keyof typeof CATALOG)[],
        ],
      ),
      url: z.url().refine((v) => {
        const u = new URL(v);
        return (
          u.protocol === "https:" &&
          !u.username &&
          !u.password &&
          !u.hash &&
          (!u.port || u.port === "443")
        );
      }),
      attribution: z.string().min(1).max(300),
      license: z.string().min(1).max(100),
    }),
  )
  .max(11);
export function configuredFeeds() {
  const feeds = configuration.parse(
    JSON.parse(process.env.TEMPERANCE_FEEDS || "[]"),
  );
  if (new Set(feeds.map((f) => f.category)).size !== feeds.length)
    throw new Error("Only one automatic feed per category is supported.");
  return feeds;
}
export function publicAddress(address: string) {
  const parts = address.split(".");
  if (
    parts.length !== 4 ||
    parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)
  )
    return false;
  const [a, b, c] = parts.map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 &&
      (b === 168 ||
        (b === 0 && (c === 0 || c === 2)) ||
        (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}
/** Pin the validated DNS answer to the TLS connection to prevent DNS rebinding.
 * No redirects, private hosts, credentials, custom ports or unbounded responses. */
export async function downloadFeed(source: string): Promise<string> {
  const url = new URL(source);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw new Error("HTTPS feed required.");
  const { lookup } = await import("node:dns/promises");
  const { get } = await import("node:https");
  const { address } = await lookup(url.hostname, { family: 4 });
  if (!publicAddress(address))
    throw new Error("Feed must use a public address.");
  return new Promise((resolve, reject) => {
    const request = get(
      {
        hostname: address,
        servername: url.hostname,
        family: 4,
        path: url.pathname + url.search,
        headers: {
          Host: url.host,
          "User-Agent": "temperance-feed/1",
          "Accept-Encoding": "identity",
        },
        timeout: 10000,
      },
      (response) => {
        if (
          response.statusCode !== 200 ||
          (response.headers["content-encoding"] &&
            response.headers["content-encoding"] !== "identity")
        ) {
          response.resume();
          reject(new Error("Feed response refused."));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            request.destroy(new Error("Feed exceeds 2 MiB."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve(Buffer.concat(chunks).toString("utf8")),
        );
        response.on("error", reject);
      },
    );
    const deadline = setTimeout(
      () => request.destroy(new Error("Feed timed out.")),
      15000,
    );
    request.once("close", () => clearTimeout(deadline));
    request.on("timeout", () => request.destroy(new Error("Feed timed out.")));
    request.on("error", reject);
  });
}
export function parseFeed(text: string) {
  const domains = new Set<string>();
  if (Buffer.byteLength(text) > 2 * 1024 * 1024)
    throw new Error("Feed exceeds 2 MiB.");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const words = line.split(/\s+/);
    if (["0.0.0.0", "127.0.0.1", "::1"].includes(words[0])) words.shift();
    for (const name of words) {
      if (
        [
          "localhost",
          "localhost.localdomain",
          "broadcasthost",
          "ip6-localhost",
          "ip6-loopback",
        ].includes(name)
      )
        continue;
      if (
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(name)
      )
        throw new Error("Unsupported feed entry.");
      domains.add(normalizeDomain(name));
      if (domains.size > 20000) throw new Error("Feed exceeds 20,000 domains.");
    }
  }
  if (!domains.size) throw new Error("Empty feed refused.");
  return [...domains].sort();
}
export function feedStatus(state: State) {
  try {
    return {
      error: null,
      feeds: configuredFeeds().map(({ category, attribution, license }) => ({
        category,
        attribution,
        license,
        ...(state.maintenance?.feeds?.[category] || {
          count: 0,
          checked_at: 0,
        }),
        stale:
          !state.maintenance?.feeds?.[category]?.updated_at ||
          Date.now() / 1000 - state.maintenance.feeds[category].updated_at! >
            2 * 86400,
      })),
    };
  } catch {
    return {
      error:
        "Invalid TEMPERANCE_FEEDS configuration. Existing lists remain in use.",
      feeds: [],
    };
  }
}
export async function refreshFeeds(
  repo: Repository,
  download = downloadFeed,
  at = Math.floor(Date.now() / 1000),
) {
  for (const source of configuredFeeds()) {
    const { state } = await repo.read();
    if (
      at - (state.maintenance?.feeds?.[source.category]?.checked_at ?? 0) <
      3600
    )
      continue;
    try {
      const domains = parseFeed(await download(source.url));
      await mutate(repo, (s) => {
        const feeds = ((s.maintenance ??= {}).feeds ??= {});
        const previous = s.extra_domains[source.category] || [];
        // Large unexpected shrinkage usually signals a truncated or changed feed.
        if (previous.length > 100 && domains.length < previous.length / 2)
          throw new Error("Feed shrank unexpectedly.");
        s.extra_domains[source.category] = domains;
        feeds[source.category] = {
          checked_at: at,
          updated_at: at,
          count: domains.length,
        };
        s.version++;
      });
    } catch {
      await mutate(repo, (s) => {
        const feeds = ((s.maintenance ??= {}).feeds ??= {});
        feeds[source.category] = {
          ...feeds[source.category],
          checked_at: at,
          count: s.extra_domains[source.category]?.length || 0,
          error:
            "Feed refresh failed validation or download. Previous domains remain active.",
        };
      });
    }
  }
}
