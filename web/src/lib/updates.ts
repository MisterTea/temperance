import { mutate, type Repository } from "./database";
import type { State, UpdateAttempt } from "./model";

export const RELEASES = "https://github.com/MisterTea/temperance/releases";
const LATEST =
  "https://api.github.com/repos/MisterTea/temperance/releases/latest";
const CHECK_EVERY = 6 * 3600_000;
const RETRY_AFTER = 15 * 60_000;

export type Install = "docker" | "linux" | "other";
export type UpdateStatus = {
  attempt?: UpdateAttempt;
  channel: "latest" | "stable" | "beta";
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
  const m =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/.exec(
      version.trim(),
    );
  return m
    ? [
        Number(m[1]),
        Number(m[2]),
        Number(m[3]),
        m[4] === undefined ? Infinity : Number(m[4]),
      ]
    : undefined;
};
function imageTag() {
  const image = process.env.TEMPERANCE_IMAGE || "mistertea/temperance:latest";
  const repository = [
    "mistertea/temperance",
    "docker.io/mistertea/temperance",
    "ghcr.io/mistertea/temperance",
  ].find((r) => image.startsWith(r + ":"));
  return repository && image.slice(repository.length + 1);
}
/** Docker's `:latest` follows every release; other installs and the `:stable`
 * and `:beta` images follow TEMPERANCE_UPDATE_CHANNEL. */
export function channel(): "latest" | "stable" | "beta" {
  if (install() === "docker" && imageTag() === "latest") return "latest";
  return process.env.TEMPERANCE_UPDATE_CHANNEL === "beta" ? "beta" : "stable";
}
const followsChannel = () => imageTag() === channel();
/** Development builds (`dev`, `0.0.0~dev.abc123`, `0.5.4-3-gabc123`) never claim to be outdated. */
export function newer(latest: string, current: string) {
  const [a, b] = [parse(latest), parse(current)];
  if (!a || !b) return false;
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] > b[i];
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

let cachedChannel: string | undefined;
let cache:
  { at: number; latest?: UpdateStatus["latest"]; error?: string } | undefined;
let pending: Promise<void> | undefined;

async function check() {
  try {
    const list = channel() !== "stable";
    const response = await fetch(
      list ? LATEST.replace(/\/latest$/, "?per_page=30") : LATEST,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "temperance/" + currentVersion(),
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.status === 404) {
      cache = { at: Date.now() };
      return;
    }
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    type Release = {
      tag_name: string;
      html_url: string;
      body?: string;
      published_at: string;
      draft?: boolean;
      prerelease?: boolean;
    };
    const payload = await response.json();
    const candidates = (list ? payload : [payload]) as Release[];
    const stable = (r: Release) => !r.prerelease && !r.tag_name.includes("-");
    const beta = (r: Release) => !!r.prerelease && r.tag_name.includes("-beta.");
    const release = candidates
      .filter(
        (r) =>
          !r.draft &&
          parse(r.tag_name) &&
          (channel() === "latest"
            ? stable(r) || beta(r)
            : channel() === "beta"
              ? beta(r)
              : stable(r)),
      )
      .sort((a, b) =>
        newer(a.tag_name, b.tag_name)
          ? -1
          : newer(b.tag_name, a.tag_name)
            ? 1
            : 0,
      )[0];
    if (!release) {
      cache = { at: Date.now() };
      return;
    }
    cache = {
      at: Date.now(),
      latest: {
        version: release.tag_name.replace(/^v/, ""),
        url: `${RELEASES}/tag/v${release.tag_name.replace(/^v/, "")}`,
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
  if (cachedChannel !== channel()) {
    cache = undefined;
    cachedChannel = channel();
  }
  const checks = checksEnabled();
  if (checks && (force || !cache || Date.now() - cache.at > CHECK_EVERY))
    await (pending ??= check().finally(() => (pending = undefined)));
  const current = currentVersion();
  const latest = checks ? cache?.latest : undefined;
  return {
    channel: channel(),
    current,
    install: install(),
    arch: process.arch,
    can_update: !!updaterToken() && followsChannel(),
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
  if (!followsChannel())
    throw new Error(
      "This image is pinned or does not match the update channel. Update its explicit version in Compose and use the recovery procedure.",
    );
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

/** Persist outcome across page refreshes and server/container replacement. */
export function reconcileAttempt(
  state: State,
  current = currentVersion(),
  at = Math.floor(Date.now() / 1000),
) {
  const attempt = state.maintenance?.update;
  if (!attempt || !["preparing", "dispatched"].includes(attempt.status))
    return attempt;
  if (current === attempt.target && current !== attempt.from) {
    attempt.status = "succeeded";
    attempt.finished_at = at;
    delete attempt.message;
  } else if (current !== attempt.from || at >= attempt.deadline_at) {
    attempt.status = "failed";
    attempt.finished_at = at;
    attempt.message =
      current !== attempt.from
        ? "Server restarted on a different version. Review the release and recovery records."
        : "Update did not complete within 10 minutes. Check the updater and use recovery if needed.";
  }
  return attempt;
}
export async function updateAttempt(
  repo: Repository,
  at = Math.floor(Date.now() / 1000),
) {
  return mutate(repo, (s) => reconcileAttempt(s, currentVersion(), at));
}
export async function requestUpdate(
  repo: Repository,
  prepare = async () => {
    const { backupNow } = await import("./maintenance");
    await backupNow(repo);
  },
  dispatch = update,
) {
  // Validate local configuration before performing release checks or creating backups.
  if (!updaterToken()) throw new Error("This install cannot update itself");
  if (!followsChannel())
    throw new Error(
      "This image is pinned or does not match the update channel.",
    );
  const candidate = await status();
  if (candidate.error || !candidate.available || !candidate.latest)
    throw new Error(
      "A successful release check for a newer version is required before updating. Check for updates again.",
    );
  const at = Math.floor(Date.now() / 1000);
  const attempt = await mutate(repo, (s) => {
    const previous = reconcileAttempt(s, candidate.current, at);
    if (previous && ["preparing", "dispatched"].includes(previous.status))
      throw new Error("An update is already in progress.");
    const record: UpdateAttempt = {
      id: crypto.randomUUID(),
      from: candidate.current,
      target: candidate.latest!.version,
      status: "preparing",
      requested_at: at,
      deadline_at: at + 600,
    };
    (s.maintenance ??= {}).update = record;
    return record;
  });
  try {
    await prepare();
    await mutate(repo, (s) => {
      if (
        s.maintenance?.update?.id !== attempt.id ||
        s.maintenance.update.status !== "preparing"
      )
        throw new Error("Update preparation expired; check the server status.");
      s.maintenance.update.status = "dispatched";
    });
    await dispatch();
  } catch (error) {
    await mutate(repo, (s) => {
      if (s.maintenance?.update?.id === attempt.id) {
        s.maintenance.update.status = "failed";
        s.maintenance.update.finished_at = Math.floor(Date.now() / 1000);
        s.maintenance.update.message =
          "Update request failed. Check recovery status and the updater connection before retrying.";
      }
    });
    throw error;
  }
}

export function resetForTests() {
  cachedChannel = undefined;
  cache = undefined;
  pending = undefined;
}
