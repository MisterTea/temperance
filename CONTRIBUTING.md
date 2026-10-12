# Contributing

The web service is Next.js (`web/`); the shared policy and client logic (`core/temperance-core`) and the WireGuard gateway it embeds (`core/temperance-gateway`) are Rust. Keep the gateway free of any HTTP server and of privileged requirements outside Linux router mode; parent-facing features belong in the web service. Run the README's checks before submitting a pull request. Include meaningful tests for changes to DNS, accounting, validation, and policy precedence.

Use synthetic browsing data in tests and screenshots. Never commit household IPs, domain logs, databases, or credentials. Keep usage estimates explicit in the interface and documentation. Make network enforcement opt-in.

For bugs, describe the expected behavior, reproduction steps, Node.js/OS versions, and relevant configuration with private information removed. For security vulnerabilities, use a private report to the repository maintainers when a public hosting repository is established; do not publish exploitable household details.

For VPN changes, run the web and gateway tests (including the tunnel test) and, for router mode, the disposable Linux integration test documented in `docs/architecture.md`. Do not run privileged integration tests on a workstation. Build affected client targets; distinguish unsigned/cross-compiled builds from installation and traffic tests on real devices. Never weaken TLS verification or commit signing keys.
