# Home-network compatibility research

Researched October 16, 2026. This covers major consumer, ISP, and enthusiast home-network families; it is not a measured market-share ranking. Vendor capabilities vary by model and firmware. Recommendations below are engineering judgments based on vendor documentation and the current repository, not hardware qualification results.

## What Temperance supports today

- A separate server with app-based WireGuard clients. Appropriate for supported phones and computers, including away from home.
- LAN DNS filtering. Clients must query Temperance directly for per-device attribution; configuring only a router's upstream resolver may hide the client behind a DNS proxy. DNS filtering cannot reliably stop existing sessions or measure actual network minutes.
- Linux IPv4 router enforcement with nftables, DNS interception, per-device policy leases and traffic accounting. Traffic must actually traverse this machine. Devices are registered by IPv4 address, not authenticated by MAC address.
- A Linux Wi-Fi access point with static client configuration.

Important gaps: `web/src/lib/home-lan.ts` and `web/src/lib/service.ts` currently gate home-device registration on the built-in AP configuration. Independent wired LAN/DNS onboarding needs work. The server is not a complete automatic home-router appliance: DHCP/address management, WAN setup, an appropriate WAN input firewall, updates and recovery need explicit configuration and qualification. The router rules in `core/temperance-gateway/src/home.rs` apply to registered IPv4 devices; they are not a complete WAN firewall or universal unknown-device admission policy. VPN clients forward public IPv6. Home-network DNS withholds AAAA answers so LAN devices do not bypass the IPv4 rules; IPv6 enforcement on the LAN needs work. Domain/category filtering remains bypassable through encrypted DNS and overlay VPNs. Router/AP modes remain experimental.

The Linux packages and container images target x64 and ARM64; the web server requires Node.js 24+. A router running Linux does not automatically make it compatible. Docker hosting does not automatically put forwarded traffic through Temperance's rules.

Repository evidence: [deployment](../deployment.md), [architecture](../architecture.md), [readiness](../beta-readiness.md), `web/package.json`, `web/src/lib/home-lan.ts`, `web/src/lib/service.ts`, and `core/temperance-gateway/src/home.rs`.

## Deployment patterns

### A. Temperance routes; the existing mesh supplies Wi-Fi

`modem/ONT → Linux Temperance router → existing Wi-Fi in AP/bridge mode → devices`

Best broadly reusable arrangement for strong home-device controls. Preserves individual client addresses on the Temperance LAN. Requires router-appliance work described above. Mesh guest networks and isolation need separate tests; do not assume guest traffic preserves device identity merely because the main network does. Some vendor parental controls, security services and QoS features are disabled in AP mode.

### B. Keep the existing router; route a protected network through Temperance

`existing router → Temperance WAN → protected LAN/VLAN and AP → devices`

Useful for prosumer installations and locked ISP gateways. Temperance sees client identities before its own NAT; the upstream router's NAT does not prevent its enforcement. There may be double NAT and cross-subnet discovery complications. Keep all protected devices behind Temperance, including wired clients. A VLAN design needs corresponding switch, AP, DHCP and routing configuration; it is not a checkbox in Temperance today.

### C. Keep everything; add direct LAN DNS and device apps

Least disruptive starting point. Advertise Temperance's LAN IP as client DNS through DHCP where supported, reserve device addresses and register them. Avoid a secondary resolver that bypasses Temperance. Validate the DNS source IP with a real client. TVs receive DNS controls only; app-supported devices can use the full VPN controls. Current AP-only registration restriction still needs fixing for ordinary LAN enrollment.

### D. Add a router enforcement adapter

Run the dashboard and policy service separately; translate decisions into the router's own firewall and collect usage. New development for every backend. Device discovery, blocking and byte totals are insufficient to reproduce category budgets: adapters need DNS attribution, minute accounting, established-session termination, restart recovery and policy-expiry handling. Offloaded traffic must not bypass accounting or rule changes. Validate supported APIs and versions before promising features.

### E. Build a transparent LAN bridge

`existing router LAN → two-port Temperance bridge → switch/AP → devices`

Potential future compatibility feature. Keeps the existing gateway and DHCP server and can observe original client addresses on the LAN. Temperance does not currently implement this mode; its routed nftables rules cannot simply be relabeled as bridge enforcement. It needs bridge filtering, IPv6 handling, attribution, lifecycle/failure behavior and physical testing. It cannot separate clients if placed on the WAN side of a NAT router, and cannot intercept Wi-Fi clients served inside the upstream router itself.

## Platform recommendations

| Platform | Best arrangement for home-device enforcement | What works with existing design / required work |
| --- | --- | --- |
| Amazon eero | A: bridge the eero mesh behind a Linux Temperance router. | eero documents preserving mesh in bridge mode. Keep the required eero topology. C is a simpler fallback; HomeKit and DNS caching/proxy behavior can hide individual DNS clients. No native Temperance package. |
| TP-Link Deco | A: AP mode behind Temperance. | Deco supports mesh and Ethernet backhaul in AP mode. Router features such as HomeShield/parental controls and DHCP move or disappear. Requires Temperance appliance setup and wired onboarding fix. |
| ASUS / ZenWiFi / AiMesh | A: AiMesh AP mode behind Temperance. | ASUS documents AiMesh in AP mode. Keep stock firmware initially. A future Asuswrt-Merlin adapter is a separate, model-dependent project; do not assume generic Linux package compatibility. |
| NETGEAR Orbi / Nighthawk | A: supported models in AP mode behind Temperance. | NETGEAR documents AP mode and disabled features. Verify exact model and guest-network behavior. C is a lower-impact fallback with direct client DNS. |
| Linksys Velop / mesh | A: mesh bridge mode behind Temperance. | Linksys documents child nodes also switching to bridge mode. Several router and parental-control features disappear. No native Temperance installation assumed. |
| Google Wifi / Nest Wifi / Nest Wifi Pro | C for minimal disruption; B with a separate protected AP for strong TV/console enforcement. | Google documents bridge mode only with a single Wi-Fi device, not a multi-device mesh. Google also uses a DNS proxy, so merely changing upstream DNS loses per-client attribution. Direct device DNS can help where configurable. Replacing the mesh is another option if whole-home routing enforcement is essential. |
| UniFi: legacy USG / USG-Pro | B: retain USG and route a protected LAN/VLAN through a separate Temperance Linux machine. C for an initial lightweight setup. | Keep UniFi APs/switches/controller. A modern UniFi API feature must not be assumed to work on legacy USG. Native porting and a legacy firewall adapter would be separate work; original USG is MIPS64/512 MB. |
| UniFi: modern gateways and APs | B when preserving the gateway; A when willing to replace routing and retain UniFi APs/switches. | UniFi documents third-party gateways with VLANs. A future API adapter could help discovery/automation, but exact writable enforcement endpoints and hardware/application support need validation. Not an existing Temperance integration. |
| TP-Link Omada | B with an existing Omada gateway; A with EAPs and switches when replacing the gateway is acceptable. | Omada documents EAP/switch use with third-party VLAN gateways and configurable LAN DHCP. Preserve the controller. Do not assume ER gateways can run the Temperance server. |
| OpenWrt | Near term: B/C with external server. Best native development target: D, a small router agent with the dashboard elsewhere. | firewall4 uses nftables, close to current enforcement code. Still needs architecture/libc packaging, service integration, DNS integration, firewall-reload compatibility and offload tests. Full server only on sufficiently capable, specifically qualified hardware. |
| GL.iNet | A using supported AP mode, or B/C while keeping GL.iNet routing. Future OpenWrt-family agent. | Hardware and vendor firmware differ; check firewall generation and storage before treating it as a native OpenWrt target. Current server packages are not universal GL.iNet installers. |
| OPNsense | B/C initially; D as the long-term integration. | Its documented plugin/backend framework makes an agent plausible. Needs a FreeBSD/pf enforcement backend and packaging rather than current Linux nftables code. |
| pfSense | B/C initially; D as a separately packaged integration. | Netgate documents its own package development and FreeBSD package requirements. Do not install the existing Linux package or assume Linux containers work as on a NAS. Needs pf-specific enforcement and lifecycle support. |
| MikroTik RouterOS | B/C near term; D through RouterOS-native firewall integration. | Compatible ARM64/x64 models may be candidates for hosting a container, after validation. Container support exists on selected architectures, but hosting alone does not enforce RouterOS transit traffic. Low-end/MIPS/ARM32 models are not covered by current images. FastTrack/offload and accounting need tests. |
| Firewalla | C with separate Temperance hosting; for strong independent controls use B. | Selected devices support Docker, making colocated VPN/DNS hosting a candidate, not a tested deployment. Keep Temperance's router rules away from the appliance firewall until coexistence is qualified. Firewalla's transparent bridge is its own capability and does not confer bridge support on Temperance. |
| Synology Router / SRM | A with wireless AP mode where appropriate; C if preserving SRM routing/features matters. | SRM documents AP mode. A Synology NAS is a separate potential Docker host for VPN/DNS; NAS support does not imply SRM supports the same containers or router enforcement. |
| FRITZ!Box / FRITZ!Mesh | C first, advertising a local DNS server directly; B for stronger controls while retaining ISP/telephony functions. | Some models can act as IP clients/APs, but modem, telephony and mesh dependencies make A model-specific. Distinguish local DNS advertised to clients from the FRITZ!Box's upstream resolver. No native package assumed. |
| Xfinity / cable ISP gateways | Bridge the ISP gateway, then A with a separate AP/mesh; otherwise B. | Xfinity documents bridge mode, with service/feature tradeoffs. Do not assume the gateway's built-in Wi-Fi remains available as a downstream AP after bridging. |
| AT&T fiber gateways | IP Passthrough to Temperance plus separate downstream Wi-Fi; B if retaining the normal gateway configuration. | Passthrough is not identical to removing the ISP gateway. Keep the gateway for ISP requirements; validate model-specific configuration and IPv6. |
| Verizon Fios | Model/service-dependent: own router at Ethernet ONT, or B behind existing equipment. | TV/MoCA/extender dependencies must be checked before replacing the gateway. Verizon fixed-wireless passthrough documentation is not proof that all Fios models have that mode. |
| T-Mobile / cellular home internet | B: keep ISP gateway, place Temperance and a separate AP downstream. | T-Mobile documents no configurable bridge mode or port forwarding and fixed gateway DNS. LAN enforcement can work behind NAT, but outside-home access to the home VPN may require the documented remote-gateway option. |

## Suggested product order

1. Fix home-device onboarding so a wired LAN/DNS/router setup works independently of Temperance's own AP. Add address reservations/discovery and explicit handling for unknown devices.
2. Qualify a two-port Linux appliance profile: DHCP, WAN configuration/input firewall, startup/recovery, IPv6 policy, updates and throughput. Publish AP-mode guides for eero, Deco, ASUS, Orbi and Linksys.
3. Build a small OpenWrt agent as the first native router integration. Preserve a common policy/accounting protocol so the backend can be reused.
4. Prototype a LAN-side transparent bridge for users keeping existing gateways and external APs. Compare its maintenance and reliability against router-specific adapters.
5. Add UniFi discovery/setup integration, separating legacy USG from modern gateways. Add enforcement only where verified APIs can satisfy the required semantics.
6. Consider OPNsense/pfSense and RouterOS adapters based on demand. Avoid maintaining unofficial native installs for every closed consumer firmware.

For the user's existing USG, B is the strongest incremental arrangement using current routing architecture. A USG adapter could avoid that topology change in the future, but is not automatically the lowest-maintenance first implementation.

## Vendor sources

- [eero with an existing router; mesh in bridge mode](https://prod.eero.com/support/articles/does-eero-replace-my-current-router)
- [eero custom DNS and HomeKit DNS proxy](https://eero.com/support/articles/how-do-i-set-up-custom-dns-servers-with-eero)
- [Deco AP mode and disabled features](https://www.tp-link.com/us/support/faq/1842/)
- [ASUS AiMesh in AP mode](https://www.asus.com/ca-en/support/faq/1043044/)
- [NETGEAR router versus AP mode](https://kb.netgear.com/000061927/What-is-the-difference-between-router-mode-and-AP-mode)
- [Linksys mesh bridge mode](https://support.linksys.com/kb/article/1537-hk/)
- [Google bridge-mode mesh restriction](https://support.google.com/googlehome/answer/6240987?hl=en)
- [Google DNS proxy](https://support.google.com/googlehome/answer/6274141?hl=en)
- [UniFi third-party gateways and VLANs](https://help.ui.com/hc/en-us/articles/9761080275607-Creating-Virtual-Networks-VLANs)
- [UniFi DHCP](https://help.ui.com/hc/en-us/articles/360012097513-UniFi-DHCP-Server)
- [Official UniFi APIs](https://help.ui.com/hc/en-us/articles/30076656117655-Getting-Started-with-the-Official-UniFi-API)
- [Original USG specifications](https://dl.ui.com/datasheets/unifi/UniFi_Security_Gateway_DS.pdf)
- [Omada with third-party gateways](https://www.tp-link.com/ro/support/faq/3655/)
- [OpenWrt firewall configuration](https://openwrt.org/docs/guide-user/firewall/firewall_configuration)
- [OpenWrt flow offloading](https://openwrt.org/docs/guide-user/perf_and_log/flow_offloading)
- [GL.iNet network modes](https://docs.gl-inet.com/router/en/4/interface_guide/network_mode/)
- [OPNsense plugin development](https://docs.opnsense.org/development/examples/helloworld.html)
- [OPNsense backend](https://wiki.opnsense.org/development/backend.html)
- [pfSense package development](https://docs.netgate.com/pfsense/en/latest/development/develop-packages.html)
- [pfSense FreeBSD package constraints](https://docs.netgate.com/pfsense/en/latest/recipes/freebsd-pkg-repo.html)
- [RouterOS containers](https://help.mikrotik.com/docs/spaces/ROS/pages/84901929/Container) (vendor marks this documentation site frozen; recheck the linked replacement manual before implementation)
- [Firewalla Docker](https://help.firewalla.com/hc/en-us/articles/360048882174-Firewalla-Tutorial-Expanding-With-Docker-Containers)
- [Firewalla transparent bridge](https://help.firewalla.com/hc/en-us/articles/1500012304202-Firewalla-Transparent-Bridge-Mode)
- [Synology SRM modes](https://kb.synology.com/knowledgebase/SRM/help/SRM/NetworkCenter/operation_modes)
- [FRITZ!Box local DNS](https://en.fritz.com/service/knowledge-base/dok/FRITZ-Box-6591-Cable/165_Configuring-different-DNS-servers-in-the-FRITZ-Box)
- [FRITZ!Box IP client mode](https://help.avm.de/fritzbox.php?deviceFeatures=1010001111111101011011111101111100011111111100100011101001&hardware=145&language=en&oem=avme&set=009&topic=hilfe_internetdual_ipclient&userSettings=1101)
- [Xfinity bridge mode](https://www.xfinity.com/support/articles/wireless-gateway-enable-disable-bridge-mode)
- [AT&T IP Passthrough](https://www.att.com/Common/storefront/resources/pdf/att_bridged_mode_vs_ip_passthrough_nov2012_v3.pdf)
- [Verizon Fios equipment](https://www.verizon.com/support/residential/internet/equipment/routers)
- [T-Mobile gateway restrictions](https://www.t-mobile.com/support/home-internet/connect)
