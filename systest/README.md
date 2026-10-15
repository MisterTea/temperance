# System tests

Client and server tested together, in isolation. One Docker Compose project starts:

- **server**: the real server image (built from `deploy/Dockerfile`, or a published
  image), with its embedded WireGuard gateway.
- **internet**: a fake internet on `198.51.100.0/24` (TEST-NET-2). It has a DNS resolver
  on `.53` and one web site per address (`allowed.test` on `.10`, `games.test` on `.11`).
  Each page's body is the site's name.
- **client**: a headless Linux device built from `tests/system.rs`. It takes the
  dashboard's setup code and signs in through `temperance-core`, the same library the
  apps use, over the gateway's WireGuard port (pinned QUIC). It then brings up a kernel
  WireGuard interface from the provisioning it was issued and browses through it; its
  later requests go inside the tunnel. It also acts as the admin, using the dashboard
  API over plain HTTP with the admin password.

Both networks are `internal`, so nothing reaches the real internet. The client isn't
on the fake internet's network: it can only reach it through the tunnel, and the first
test checks that.

## Running

You need Docker with Compose v2, on Linux with the `wireguard` kernel module (any
kernel since 5.6). On macOS or Windows, run it inside a Linux VM.

```sh
sh systest/run.sh                       # build from source and run everything
sh systest/run.sh pause_and_bedtime     # one test, by name filter
TEMPERANCE_SYSTEST_SERVER_IMAGE=mistertea/temperance:latest sh systest/run.sh
```

`run.sh` exits with the client's status. When a test fails, it prints the server and DNS
logs. The `System tests` workflow runs it on every push. Run it manually with an
`image` input to test a release.

`cargo test` in `systest/` builds the client but skips every test outside this
environment (`TEMPERANCE_SYSTEST=1` turns them on).

## Scenarios

| Test | Checks |
| --- | --- |
| `the_fake_internet_is_only_reachable_through_the_tunnel` | isolation holds; enroll, connect, browse |
| `denied_domains_are_filtered_and_the_parent_sees_the_history` | deny list via the tunnel's DNS and via an outside resolver (intercepted); history reaches the dashboard |
| `the_daily_limit_blocks_until_a_parent_approves_more_time` | gateway minute accounting, limit blocks, the client's time request, the admin's approval restores access |
| `pause_and_bedtime_block_browsing_until_lifted` | pause and a bedtime window around the current time (server timezone UTC), each lifted again |
| `a_revoked_device_loses_the_tunnel_and_the_api` | revoking removes the WireGuard peer and the device token |

Policy changes are expected to take effect within 30 seconds (`POLICY_DELAY`).
