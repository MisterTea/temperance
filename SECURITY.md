# Security reports

Report vulnerabilities privately using [GitHub private vulnerability reporting](https://github.com/MisterTea/temperance/security/advisories/new). Repository maintainers must enable that feature before inviting external beta households. If it is unavailable, do not post household credentials, logs, exploit details, or locations in a public issue; ask the maintainer for a private reporting channel.

Temperance is in beta preparation. Only the current explicitly designated beta release will receive beta fixes; no production support lifetime is promised yet. Security fixes take priority over feature work. Each release must record its reviewed dependency versions, supported server/app combinations and unresolved findings in the release evidence.

Browsing history, recovery archives, configuration exports, `.env` files and gateway identities are sensitive. Use Settings → Download support report for the allowlisted diagnostic summary. Even that report should be reviewed before sharing. Keep signing keys, SMTP credentials, recovery passphrases and household data out of issues and source control.

The reference beta configuration is one household on Linux/Docker with SQLite. Domain filtering is not comprehensive content inspection. Unmanaged users can remove the VPN; encrypted DNS and overlay VPNs limit filtering. A gateway outage interrupts internet access through that gateway. See `docs/architecture.md` for the trust boundaries and enforcement limits.
