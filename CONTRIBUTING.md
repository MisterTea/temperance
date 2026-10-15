# Contributing

The web service is Next.js (`web/`); the shared policy and device-app logic (`core/temperance-core`) and the WireGuard gateway it embeds (`core/temperance-gateway`) are Rust. Keep the gateway free of any HTTP server and of privileged requirements outside Linux router mode; admin-facing features belong in the web service. Run the README's checks before submitting a pull request. Include meaningful tests for changes to DNS, accounting, validation, and policy precedence.

## Vocabulary

Use these words in the interface, headings, docs, and the messages a client sees. The person who changes the rules is an admin, as in "An admin paused this device." Age presets stay Young child, Teen, and Adult.

| Word | Means |
| --- | --- |
| **Admin** | Anyone who can change the rules: the admin password, or a phone or computer paired to open the dashboard. |
| **Client** | The person the rules and the time budget belong to. In code this is a profile. |
| **Device** | A phone, computer, TV, or console. |
| **App** | The Temperance program on a device. |

Do not call the app a client. Age presets stay Young child, Teen, and Adult.

On disk and on the wire, paired admin devices are still named `parent`: `/api/parents`, `parent.key`, `TEMPERANCE_REMOTE_PARENTS`, and the `temperance-parent/1` ALPN. `User.role` is `user` for a client's sign-in and `owner` for the account created from the admin password. A paired admin device is a `Parent` record, not a user role.

Use synthetic browsing data in tests and screenshots. Never commit household IPs, domain logs, databases, or credentials. Keep usage estimates explicit in the interface and documentation. Make network enforcement opt-in.

For bugs, describe the expected behavior, reproduction steps, Node.js/OS versions, and relevant configuration with private information removed. For security vulnerabilities, use a private report to the repository maintainers when a public hosting repository is established; do not publish exploitable household details.

For VPN changes, run the web and gateway tests (including the tunnel test) and, for router mode, the disposable Linux integration test documented in `docs/architecture.md`. Do not run privileged integration tests on a workstation. Build affected client targets; distinguish unsigned/cross-compiled builds from installation and traffic tests on real devices. Never weaken TLS verification or commit signing keys.
