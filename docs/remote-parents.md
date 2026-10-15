# Admin devices: the dashboard from anywhere

An admin can make exceptions and change the rules while away from home, at work or on mobile data, without a VPN profile and without setting up HTTPS. They pair a phone or computer once, by scanning a QR code on the dashboard, and the Temperance app then opens the family dashboard wherever it is. For a household that is usually a parent.

There is nothing to configure and nothing extra to forward. Admin-device connections arrive on the same UDP port as the family VPN (51820 unless `TEMPERANCE_VPN_ENDPOINT` names another), which the [router guide](routers.md) already covers. On disk and on the wire this channel is still named `parent` (`parent.key`, `/api/parents`, `TEMPERANCE_REMOTE_PARENTS`).

## Pair an admin's phone

1. At home, open the dashboard and go to **Devices → Admin devices**, then choose **Pair an admin device**. A QR code appears. It works once, for ten minutes.
2. Install Temperance on the admin's phone or computer and choose **I'm an admin** on the first screen. Admin mode never asks for VPN permission.
3. Pair it:
   - **iPhone and iPad:** tap **Scan the QR code**, or paste the link.
   - **Android:** tap **Scan the QR code** (Temperance asks for the camera once), or paste the link.
   - **Mac:** choose **Copy pairing link** on the dashboard, then paste it into the app.
   - **Windows and Linux:** choose **Copy pairing link** on the dashboard, paste it into the Temperance app and choose **Pair and open the dashboard**. The dashboard opens in its own Temperance window. On Linux the app has only admin mode, so it goes straight to this screen.
4. The dashboard opens. The phone appears under **Admin devices** with when it was paired and last used.

From then on, open the app and the dashboard is there. A paired phone is signed in as an admin: it can do everything the admin password can, except sign out. To stop a phone, revoke it.

## Revoke a phone

In **Devices → Admin devices**, choose **Revoke** next to the phone. Its connection closes within a few seconds and it cannot reconnect; the app says the phone was removed and asks to pair again. A phone cannot revoke itself, so a lost phone is removed from another paired phone or from the dashboard at home. On the phone itself, **Unpair this phone** deletes the pairing.

## How it works

```text
admin's phone                                home
┌────────────────────────┐                    ┌───────────────────────────────┐
│ app web view            │                    │ Temperance                    │
│   │ http://127.0.0.1    │   QUIC, UDP 51820  │  gateway ── http ──▶ dashboard │
│   ▼                     │ ═════════════════▶ │  (same socket as WireGuard)   │
│ local proxy (core)      │   pinned keys      │                               │
└────────────────────────┘                    └───────────────────────────────┘
```

- **One port, two protocols.** The gateway tells the protocols apart by each packet's first byte: WireGuard messages start with a type of 1 to 4 followed by three zero bytes, and QUIC packets have their fixed bit set. WireGuard devices are unaffected.
- **QUIC with pinned keys instead of HTTPS.** The app speaks QUIC (TLS 1.3) to the gateway. There is no certificate authority and no domain name to prove: the QR code carries the fingerprint of the gateway's own key, and the app refuses any other key. The phone has its own key too, generated during pairing and kept in the Keychain (Apple) or the Keystore-encrypted vault (Android). The gateway accepts only keys it has paired.
- **Pairing.** The QR code holds `temperance://pair#…`: the home's address (the Dynu hostname if one is set, otherwise the host in `TEMPERANCE_VPN_ENDPOINT`), the port, the gateway's key fingerprint, the household name and a single-use code. The gateway checks the code with the dashboard, which stores only its hash, discards it on use and keeps it for ten minutes at most. The gateway allows five pairing attempts a minute from one address and thirty in total.
- **Forwarding.** The app runs a small proxy on the phone's loopback address and points its web view at it. A one-time token in the first URL sets a cookie only that web view holds. Other apps on the phone cannot use the proxy, and neither can web pages, because Host and Origin are checked. Each request travels over the QUIC connection. The gateway removes any `x-temperance-*` headers the phone sent and adds two of its own: the admin device's id and a secret it shares with the dashboard. The dashboard trusts a request as that device's only when that secret matches. Requests to the gateway's own API (`/v1/gateway/…`) are refused.
- **The secret.** The embedded gateway generates a fresh forwarding secret each time Temperance starts, and the secret never leaves the process. A separate gateway (`temperance-gateway --parent-key-file`) uses its `TEMPERANCE_GATEWAY_TOKEN` instead.

## Settings

| Setting | Effect |
| --- | --- |
| `TEMPERANCE_HOUSEHOLD_NAME` | Shown in the app after pairing, for example `The Parkers`. |
| `TEMPERANCE_REMOTE_PARENTS=off` | Turns admin-device access off: pairing and those connections are refused. Client devices still sign in over the same port. |
| `<data dir>/parent.key` | The gateway's QUIC key, created on first start (mode 600). Admin phones and client devices pin it. Back it up with `gateway.key`: if it is lost, every admin phone must pair again and every client's device must be set up again. |

With a separate gateway machine, add `--parent-key-file /var/lib/temperance/parent.key` to `temperance-gateway`. It forwards admin-device requests to `--service` over HTTPS.

The dashboard also limits sign-in with the admin password: after ten wrong passwords from one address (or a hundred overall) in 15 minutes, it waits before accepting more.

## Troubleshooting

- **"Can't reach your home's Temperance gateway"**: the phone could not get a reply on the UDP port. Check that family devices can connect from outside the home (see [Still not connecting?](routers.md#still-not-connecting)). Some guest and workplace Wi-Fi networks block UDP except for web traffic; try mobile data.
- **"Admin devices connect through the home gateway, which hasn’t checked in yet"**: the dashboard runs without its gateway. Set `TEMPERANCE_GATEWAY_LISTEN`, or run `temperance-gateway` with `--parent-key-file`.
- **"Set TEMPERANCE_VPN_ENDPOINT…"**: the dashboard does not know the home's public address. Set it as for family devices.
- **"That pairing code has expired or was already used"**: create a new code; each one works once, for ten minutes.
- **"This device was removed from the family's admin devices"**: the phone was revoked. Unpair it in the app and pair it again if needed.
