import { beforeEach, describe, it, expect } from "vitest";
import { handle } from "../src/lib/http";
import { TestRepository } from "../src/lib/database";
import { hashPassword, verifyPassword } from "../src/lib/accounts";
const ADMIN = "simple-admin-password",
  GATEWAY = "g".repeat(48),
  PUBLIC = btoa(
    String.fromCharCode(...Array.from({ length: 32 }, (_, n) => n + 1)),
  );
beforeEach(() => {
  process.env.TEMPERANCE_ADMIN_PASSWORD = ADMIN;
  process.env.TEMPERANCE_GATEWAY_TOKEN = GATEWAY;
  process.env.TEMPERANCE_PUBLIC_URL = "http://127.0.0.1:3000";
  process.env.TEMPERANCE_VPN_ENDPOINT = "192.0.2.1:51820";
  process.env.TEMPERANCE_VPN_PUBLIC_KEY = PUBLIC;
});
async function call(
  repo: TestRepository,
  path: string,
  data?: unknown,
  headers: Record<string, string> = {},
) {
  return handle(
    new Request("http://127.0.0.1:3000/" + path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:3000",
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    }),
    path,
    repo,
  );
}
async function setup() {
  const repo = new TestRepository();
  const login = await call(repo, "v1/login", { password: ADMIN });
  const cookie = login.headers.get("set-cookie")!;
  const headers = { Cookie: cookie };
  await call(repo, "api/profiles", { name: "Alex" }, headers);
  await call(repo, "api/profiles", { name: "Sam" }, headers);
  const user = await (
    await call(
      repo,
      "api/users",
      { username: "alex", password: "simple-user-password", profile_id: 1 },
      headers,
    )
  ).json();
  return { repo, user, headers };
}
describe("simple admin password and client IAM", () => {
  it("website accepts only the admin password and requires same-origin cookie writes", async () => {
    const { repo, headers } = await setup();
    expect(headers.Cookie).toContain("temperance_session=a1.");
    expect(
      (await call(repo, "v1/login", { password: "simple-user-password" }))
        .status,
    ).toBe(401);
    expect(
      (
        await call(
          repo,
          "api/profiles",
          { name: "Bad" },
          { ...headers, Origin: "http://evil.test" },
        )
      ).status,
    ).toBe(403);
    expect((await call(repo, "api/state")).status).toBe(401);
    expect(
      (await call(repo, "v1/oauth/token", { grant_type: "password" })).status,
    ).toBe(404);
  });
  it("registers a client to the user’s assigned profile, never a chosen profile or admin role", async () => {
    const { repo, headers, user } = await setup();
    const login = await call(repo, "v1/device/login", {
      username: "ALEX",
      password: "simple-user-password",
      name: "Phone",
      public_key: PUBLIC,
      profile_id: 2,
    });
    expect(login.status).toBe(200);
    const device = await login.json();
    expect(device.policy.id).toBe(1);
    expect(await verifyPassword("Temperance emergency VPN unlock v1\0" + ADMIN, device.emergency_unlock)).toBe(true);
    expect(await verifyPassword(ADMIN, device.emergency_unlock)).toBe(false);
    expect(device.user.id).toBe(user.id);
    expect(
      (
        await call(
          repo,
          "api/users",
          { username: "ALEX", password: "another-password", profile_id: 1 },
          headers,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(repo, "api/state", undefined, {
          Authorization: "Bearer " + device.token,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call(repo, "v1/device/state", undefined, {
          Authorization: "Bearer " + device.token,
        })
      ).status,
    ).toBe(200);
    const stored = (await repo.read()).state;
    expect(JSON.stringify(stored)).not.toContain("simple-user-password");
    expect(stored.devices[0].user_id).toBe(user.id);
    expect(
      JSON.stringify(
        await (await call(repo, "api/users", undefined, headers)).json(),
      ),
    ).not.toContain("password_hash");
  });
  it("a client keeps its rules, and resetting the password revokes devices", async () => {
    const { repo, headers, user } = await setup();
    const device = await (
      await call(repo, "v1/device/login", {
        username: "alex",
        password: "simple-user-password",
        name: "Phone",
        public_key: PUBLIC,
      })
    ).json();
    expect(
      (
        await call(
          repo,
          "api/users/update",
          { id: user.id, profile_id: 2 },
          headers,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await (
          await call(repo, "v1/device/state", undefined, {
            Authorization: "Bearer " + device.token,
          })
        ).json()
      ).policy.id,
    ).toBe(1);
    await call(
      repo,
      "api/users/update",
      { id: user.id, password: "replacement-password" },
      headers,
    );
    expect(
      (
        await call(repo, "v1/device/state", undefined, {
          Authorization: "Bearer " + device.token,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await (
          await call(repo, "v1/gateway/state", undefined, {
            Authorization: "Bearer " + GATEWAY,
          })
        ).json()
      ).peers,
    ).toHaveLength(0);
    expect(
      (
        await call(repo, "v1/device/login", {
          username: "alex",
          password: "simple-user-password",
          name: "Phone",
          public_key: PUBLIC,
        })
      ).status,
    ).toBe(401);
  });
  it("deleting or disabling a client user immediately revokes its scope", async () => {
    for (const action of ["disable", "delete"]) {
      const { repo, headers, user } = await setup();
      const device = await (
        await call(repo, "v1/device/login", {
          username: "alex",
          password: "simple-user-password",
          name: "Phone",
          public_key: PUBLIC,
        })
      ).json();
      const result =
        action === "delete"
          ? await call(repo, "api/users/delete", { id: user.id }, headers)
          : await call(
              repo,
              "api/users/update",
              { id: user.id, disabled: true },
              headers,
            );
      expect(result.status).toBe(200);
      expect(
        (
          await call(repo, "v1/device/state", undefined, {
            Authorization: "Bearer " + device.token,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await (
            await call(repo, "v1/gateway/state", undefined, {
              Authorization: "Bearer " + GATEWAY,
            })
          ).json()
        ).peers,
      ).toHaveLength(0);
    }
  });
  it("invalid attempts are persisted and lock only the client account", async () => {
    const { repo } = await setup();
    for (let n = 0; n < 10; n++)
      await call(repo, "v1/device/login", {
        username: "alex",
        password: "wrong",
        name: "Phone",
        public_key: PUBLIC,
      });
    expect((await repo.read()).state.users![0].locked_until).toBeGreaterThan(
      Date.now() / 1000,
    );
    expect(
      (
        await call(repo, "v1/device/login", {
          username: "alex",
          password: "simple-user-password",
          name: "Phone",
          public_key: PUBLIC,
        })
      ).status,
    ).toBe(401);
    expect((await call(repo, "v1/login", { password: ADMIN })).status).toBe(
      200,
    );
  });
  it("round-trips IAM identity in backups without plaintext passwords", async () => {
    const { repo, headers } = await setup();
    const device = await (
      await call(repo, "v1/device/login", {
        username: "alex",
        password: "simple-user-password",
        name: "Phone",
        public_key: PUBLIC,
      })
    ).json();
    const backup = await (
      await call(repo, "api/export", undefined, headers)
    ).json();
    expect(JSON.stringify(backup)).not.toContain("simple-user-password");
    const next = new TestRepository();
    expect(
      (await call(next, "api/import", { confirm: "RESTORE", backup }, headers))
        .status,
    ).toBe(200);
    expect(
      (
        await call(next, "v1/device/state", undefined, {
          Authorization: "Bearer " + device.token,
        })
      ).status,
    ).toBe(200);
  });
  it("replaces a client's old name with the username", async () => {
    const { repo, headers } = await setup();
    const current = await repo.read();
    const client = current.state.profiles.find((p) => p.id === 1)!;
    client.name = "GauciKids";
    expect(await repo.commit(current.state, current.revision)).toBe(true);
    const view = await (
      await call(repo, "api/state", undefined, headers)
    ).json();
    expect(view.profiles.find((p: { id: number }) => p.id === 1).name).toBe(
      "alex",
    );
    const stored = await repo.read();
    expect(stored.state.profiles.find((p) => p.id === 1)?.name).toBe("alex");
    expect(stored.state.users?.[0].username).toBe("alex");
  });
  it("hashes passwords with independent salts", async () => {
    const a = await hashPassword("simple-user-password"),
      b = await hashPassword("simple-user-password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("simple-user-password", a)).toBe(true);
    expect(await verifyPassword("wrong", a)).toBe(false);
    expect(await verifyPassword("wrong", "pbkdf2-sha256$NaN$x$y")).toBe(false);
  });
});
