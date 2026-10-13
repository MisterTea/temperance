export const RELEASES = "https://github.com/MisterTea/temperance/releases";
const LATEST =
  "https://api.github.com/repos/MisterTea/temperance/releases/latest";
const CHECK_EVERY = 6 * 3600_000;
const RETRY_AFTER = 15 * 60_000;

export type Install = "docker" | "linux" | "other";
export type UpdateStatus = {
  current: string;
  install: Install;
  arch: string;
  /** Docker installs with the updater container can update from the dashboard. */
  can_update: boolean;
  checks: boolean;
  latest?: {
    version: string;
    url: string;
    notes: string;
    published_at: string;
  };
  available: boolean;
  checked_at?: number;
  error?: string;
};

/** Set at build time from TEMPERANCE_VERSION or `git describe` (see next.config.ts). */
export const currentVersion = () =>
  process.env.TEMPERANCE_BUILD_VERSION || "dev";

const parse = (version: string) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return m ? m.slice(1).map(Number) : undefined;
};
/** Development builds (`dev`, `0.0.0~dev.abc123`, `0.5.4-3-gabc123`) never claim to be outdated. */
export function newer(latest: string, current: string) {
  const [a, b] = [parse(latest), parse(current)];
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

const install = (): Install =>
  process.env.TEMPERANCE_INSTALL === "docker"
    ? "docker"
    : process.env.TEMPERANCE_INSTALL === "linux"
      ? "linux"
      : "other";
const updaterToken = () =>
  install() === "docker" ? process.env.TEMPERANCE_UPDATER_TOKEN : undefined;
const checksEnabled = () =>
  !/^(off|false|0|no)$/i.test(process.env.TEMPERANCE_UPDATE_CHECK ?? "");

let cache:
  { at: number; latest?: UpdateStatus["latest"]; error?: string } | undefined;
let pending: Promise<void> | undefined;

async function check() {
  try {
    const response = await fetch(LATEST, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "temperance/" + currentVersion(),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) {
      cache = { at: Date.now() };
      return;
    }
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const release = (await response.json()) as {
      tag_name: string;
      html_url: string;
      body?: string;
      published_at: string;
    };
    cache = {
      at: Date.now(),
      latest: {
        version: release.tag_name.replace(/^v/, ""),
        url: release.html_url,
        notes: (release.body ?? "").slice(0, 4000),
        published_at: release.published_at,
      },
    };
  } catch (e) {
    cache = {
      at: Date.now() - CHECK_EVERY + RETRY_AFTER,
      latest: cache?.latest,
      error: e instanceof Error ? e.message : "Could not check for updates",
    };
  }
}

/** The release check runs at most every six hours; `force` checks now. */
export async function status(force = false): Promise<UpdateStatus> {
  const checks = checksEnabled();
  if (checks && (force || !cache || Date.now() - cache.at > CHECK_EVERY))
    await (pending ??= check().finally(() => (pending = undefined)));
  const current = currentVersion();
  const latest = checks ? cache?.latest : undefined;
  return {
    current,
    install: install(),
    arch: process.arch,
    can_update: !!updaterToken(),
    checks,
    latest,
    available: !!latest && newer(latest.version, current),
    checked_at: checks && cache ? Math.floor(cache.at / 1000) : undefined,
    error: checks ? cache?.error : undefined,
  };
}

/** Asks the Watchtower container (deploy/docker/compose.yml) to pull the new image and recreate this one. */
export async function update() {
  const token = updaterToken();
  if (!token) throw new Error("This install cannot update itself");
  const base = process.env.TEMPERANCE_UPDATER_URL || "http://updater:8080";
  let response: Response;
  try {
    response = await fetch(base + "/v1/update?async=true", {
      method: "POST",
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(
      "Could not reach the updater container. Is COMPOSE_PROFILES set to include updater?",
    );
  }
  if (!response.ok)
    throw new Error(`The updater container answered ${response.status}`);
}

export function resetForTests() {
  cache = undefined;
  pending = undefined;
}
