import { beforeEach, describe, expect, it, vi } from "vitest";
import { TestRepository } from "../src/lib/database";
import { handle } from "../src/lib/http";
import {
  accessToken,
  hashPassword,
  verifyAccess,
  verifyPassword,
} from "../src/lib/accounts";
import { emptyState } from "../src/lib/model";

const ADMIN = "a".repeat(48);
const ORIGIN = "http://127.0.0.1:3000";
beforeEach(() => {
  vi.useRealTimers();
  process.env.TEMPERANCE_ADMIN_TOKEN = ADMIN;
  process.env.TEMPERANCE_GATEWAY_TOKEN = "g".repeat(48);
  process.env.TEMPERANCE_PUBLIC_URL = ORIGIN;
  process.env.TEMPERANCE_TIMEZONE = "UTC";
});
function call(
  repo: TestRepository,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const encoded =
    typeof body === "string" || body === undefined
      ? body
      : JSON.stringify(body);
  return handle(
    new Request(ORIGIN + "/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        ...headers,
      },
      body: encoded,
    }),
    path,
    repo,
  );
}
const owner = { username: "Mom", password: "a long passphrase" };
async function setup(repo = new TestRepository()) {
  const response = await call(repo, "v1/setup", {
    setup_token: ADMIN,
    ...owner,
  });
  expect(response.status).toBe(200);
  return {
    repo,
    cookie: response.headers.get("set-cookie")!.split(";")[0],
  };
}

describe("password storage", () => {
  it("never stores the plaintext password and verifies hashes", async () => {
    const stored = await hashPassword("secret password", 1000);
    expect(stored).not.toContain("secret password");
    expect(stored).toMatch(/^pbkdf2-sha256\$1000\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
    expect(await verifyPassword("secret password", stored)).toBe(true);
    expect(await verifyPassword("wrong password", stored)).toBe(false);
    expect(await verifyPassword("x", "md5$bad")).toBe(false);
    expect(await hashPassword("same", 1000)).not.toBe(
      await hashPassword("same", 1000),
    );
  });
});

describe("first-run setup and sign-in", () => {
  it("requires the setup token once, then signs in by username and password", async () => {
    const repo = new TestRepository();
    expect(await (await call(repo, "v1/setup")).json()).toEqual({
      needs_setup: true,
    });
    expect(
      (
        await call(repo, "v1/setup", {
          setup_token: "nope",
          ...owner,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call(
          repo,
          "v1/setup",
          { setup_token: ADMIN, ...owner },
          {
            Origin: "http://evil.test",
          },
        )
      ).status,
    ).toBe(403);
    const { cookie } = await setup(repo);
    expect(cookie).toMatch(/^temperance_session=u1\./);
    expect(await (await call(repo, "v1/setup")).json()).toEqual({
      needs_setup: false,
    });
    expect(
      (await call(repo, "v1/setup", { setup_token: ADMIN, ...owner })).status,
    ).toBe(409);
    const state = (await repo.read()).state;
    expect(JSON.stringify(state)).not.toContain(owner.password);
    expect(state.users![0]).toMatchObject({ username: "mom", role: "owner" });

    const me = await call(repo, "api/me", undefined, { Cookie: cookie });
    expect(await me.json()).toMatchObject({ username: "mom", role: "owner" });
    const login = await call(repo, "v1/login", {
      username: "MOM",
      password: owner.password,
    });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    expect(
      (await call(repo, "v1/login", { username: "mom", password: "bad" }))
        .status,
    ).toBe(401);
    expect(
      (await call(repo, "v1/login", { username: "ghost", password: "bad" }))
        .status,
    ).toBe(401);
    const logout = await call(repo, "v1/logout", {});
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await call(repo, "api/state")).status).toBe(401);
    expect((await call(repo, "v1/oauth/nothing", {})).status).toBe(404);
    expect((await call(repo, "v1/login")).status).toBe(404);
  });

  it("locks an account after repeated failures", async () => {
    const { repo } = await setup();
    for (let i = 0; i < 10; i++)
      await call(repo, "v1/login", { username: "mom", password: "bad" });
    expect((await repo.read()).state.users![0].locked_until).toBeGreaterThan(
      Date.now() / 1000,
    );
    expect((await call(repo, "v1/login", owner)).status).toBe(401);
  });
});

describe("OAuth 2.0 token endpoint", () => {
  it("issues, refreshes with rotation, and revokes tokens", async () => {
    const { repo } = await setup();
    const form = new URLSearchParams({
      grant_type: "password",
      username: "mom",
      password: owner.password,
      client_id: "temperance-ios",
    }).toString();
    const issued = await call(repo, "v1/oauth/token", form, {
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect(issued.status).toBe(200);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    const tokens = await issued.json();
    expect(tokens).toMatchObject({
      token_type: "Bearer",
      expires_in: 3600,
      scope: "family:admin",
    });
    const auth = { Authorization: "Bearer " + tokens.access_token };
    expect((await call(repo, "api/state", undefined, auth)).status).toBe(200);
    expect(
      (
        await call(
          repo,
          "api/profiles",
          { name: "Kid" },
          { ...auth, Origin: "" },
        )
      ).status,
    ).toBe(200);

    const refreshed = await (
      await call(repo, "v1/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
      })
    ).json();
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
    const reuse = await call(repo, "v1/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    expect(reuse.status).toBe(400);
    expect((await reuse.json()).error).toBe("invalid_grant");

    await call(repo, "v1/oauth/revoke", { token: refreshed.refresh_token });
    expect(
      (
        await call(repo, "v1/oauth/token", {
          grant_type: "refresh_token",
          refresh_token: refreshed.refresh_token,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(repo, "v1/oauth/token", {
          grant_type: "password",
          username: "mom",
          password: "wrong",
        })
      ).status,
    ).toBe(400);
    const bad = await call(repo, "v1/oauth/token", {
      grant_type: "client_credentials",
    });
    expect((await bad.json()).error).toBe("unsupported_grant_type");
  });

  it("rejects forged, expired, and stale access tokens", async () => {
    const state = emptyState();
    state.users = [
      {
        id: "u",
        username: "mom",
        password_hash: "x",
        role: "owner",
        session_version: 1,
        created_at: 0,
        failed_logins: 0,
      },
    ];
    const good = await accessToken(state.users[0]);
    expect(await verifyAccess(state, good)).toBe(state.users[0]);
    expect(await verifyAccess(state, good.slice(0, -1) + "0")).toBeUndefined();
    expect(await verifyAccess(state, "garbage")).toBeUndefined();
    expect(
      await verifyAccess(state, await accessToken(state.users[0], -1)),
    ).toBeUndefined();
    state.users[0].session_version = 2;
    expect(await verifyAccess(state, good)).toBeUndefined();
  });
});

describe("family administrators", () => {
  it("lets the owner add co-parents and everyone change their password", async () => {
    const { repo, cookie } = await setup();
    const added = await call(
      repo,
      "api/users",
      { username: "dad", password: "another passphrase" },
      { Cookie: cookie },
    );
    expect(added.status).toBe(200);
    const dad = await added.json();
    expect(dad).toMatchObject({ username: "dad", role: "parent" });
    expect(dad.password_hash).toBeUndefined();
    expect(
      (
        await call(
          repo,
          "api/users",
          { username: "dad", password: "another passphrase" },
          { Cookie: cookie },
        )
      ).status,
    ).toBe(400);
    const list = await (
      await call(repo, "api/users", undefined, { Cookie: cookie })
    ).json();
    expect(list.map((u: { username: string }) => u.username)).toEqual([
      "mom",
      "dad",
    ]);

    const dadCookie = (
      await call(repo, "v1/login", {
        username: "dad",
        password: "another passphrase",
      })
    ).headers
      .get("set-cookie")!
      .split(";")[0];
    expect(
      (
        await call(
          repo,
          "api/users",
          { username: "kid", password: "kid passphrase" },
          { Cookie: dadCookie },
        )
      ).status,
    ).toBe(403);
    const momId = list[0].id;
    expect(
      (
        await call(
          repo,
          "api/users/delete",
          { id: momId },
          { Cookie: dadCookie },
        )
      ).status,
    ).toBe(400);
    expect(
      (await call(repo, "api/users/delete", { id: momId }, { Cookie: cookie }))
        .status,
    ).toBe(400);
    expect(
      (
        await call(
          repo,
          "api/password",
          { current_password: "wrong", new_password: "brand new passphrase" },
          { Cookie: dadCookie },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          repo,
          "api/password",
          {
            current_password: "another passphrase",
            new_password: "brand new passphrase",
          },
          { Cookie: dadCookie },
        )
      ).status,
    ).toBe(200);
    expect(
      (await call(repo, "api/state", undefined, { Cookie: dadCookie })).status,
    ).toBe(401);
    expect(
      (
        await call(
          repo,
          "api/password",
          { current_password: "x", new_password: "y".repeat(12) },
          {
            Authorization: "Bearer " + ADMIN,
          },
        )
      ).status,
    ).toBe(400);
    expect(
      (await call(repo, "api/users/delete", { id: dad.id }, { Cookie: cookie }))
        .status,
    ).toBe(200);
    expect(
      (
        await call(
          repo,
          "api/users/delete",
          { id: "missing" },
          { Cookie: cookie },
        )
      ).status,
    ).toBe(400);
  });

  it("keeps accounts out of backups and preserves them on restore", async () => {
    const { repo, cookie } = await setup();
    const backup = await (
      await call(repo, "api/export", undefined, { Cookie: cookie })
    ).json();
    expect(backup.state.users).toBeUndefined();
    expect(backup.state.refresh_tokens).toBeUndefined();
    expect(
      (
        await call(
          repo,
          "api/import",
          { confirm: "RESTORE", backup },
          { Cookie: cookie },
        )
      ).status,
    ).toBe(200);
    expect((await repo.read()).state.users).toHaveLength(1);
  });
});
