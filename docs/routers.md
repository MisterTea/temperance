# Router guide: let devices reach your home gateway

Phones and laptops on the family VPN connect to your Temperance machine from anywhere, so your router must pass one port through to it: **UDP 51820** (or whatever port `TEMPERANCE_VPN_ENDPOINT` names). Temperance also needs a name that keeps pointing at your home when your ISP changes its address.

Temperance tries to do both for you. Check **Settings → Remote access** in the dashboard:

- **Port forwarding (UPnP)** is on by default. The gateway asks the router to forward the port, renews the request every 20 minutes and removes it when Temperance stops. If the status line is green, you can skip the router steps below.
- **Dynamic DNS** keeps a free [Dynu](https://www.dynu.com/) hostname pointed at your home's public address.

Admin phones that open the dashboard away from home ([admin devices](remote-parents.md)) use the same UDP port, so there is nothing extra to forward for them.

## Before you start

1. **Give the Temperance machine a fixed LAN address.** Port forwards point at an address, so reserve one for the machine in the router's DHCP settings ("address reservation", "IP reservation" or "static lease"). Every section below starts there.
2. **Check that your router has a public address.** Open the router's status page and find its WAN or internet IP. If it starts with `10.`, `192.168.`, `172.16.`–`172.31.` or `100.64.`–`100.127.`, there is another router in front of yours (often the ISP's modem/router combo) or your ISP uses carrier-grade NAT (CGNAT). Port forwarding on your router alone cannot work then. Temperance's dashboard shows a warning when it sees this. Fixes:
   - Put the ISP's box in **bridge mode** (sometimes called "modem only" or "IP passthrough") so your own router gets the public address. Or forward the port on the ISP box too, to your router's WAN address.
   - Ask the ISP for a public IPv4 address. Many provide one on request, sometimes for a small fee.
   - Or run the gateway on a small VPS ([remote gateway](deployment.md#remote-gateway-optional)).
3. **Test from outside your home.** Many routers cannot loop traffic from inside your network back to your own public address. Turn off Wi-Fi on a phone, connect the Temperance app over mobile data, and check that the device shows as active in the dashboard.

The protocol is always **UDP**. A TCP forward does nothing for WireGuard. Use the same number for the external and internal port unless you changed the gateway's listen port. Only if you put Caddy in front of the dashboard for browsers away from home, also forward **TCP 80 and 443**; UPnP only maps the VPN port. Devices and admin phones need only the UDP port.

## Dynamic DNS with Dynu

Temperance has a built-in updater for Dynu, a free dynamic DNS service.

1. Create an account at [dynu.com](https://www.dynu.com/) and add a hostname under **Control Panel → DDNS Services**, for example `myhome.ddnsfree.com`.
2. Under **Control Panel → My Account → Username/Password**, set an **IP update password**. This password can only update addresses, not log into your account.
3. In Temperance, open **Settings → Remote access**, enter the hostname, your Dynu username and the IP update password, and save. The status line shows when the name was last pointed at your address.
4. Set `TEMPERANCE_VPN_ENDPOINT=myhome.ddnsfree.com:51820` (and, if you serve the dashboard on the same name, `TEMPERANCE_PUBLIC_URL=https://myhome.ddnsfree.com`), then restart Temperance. Devices pick up the new endpoint the next time they refresh.

The gateway checks your public address every 5 minutes and tells Dynu only when it changes, plus once a day. If your router has its own dynamic DNS client, you can use that instead and leave the Dynu fields empty.

## TP-Link (Archer and other routers with a web interface)

Log in at [tplinkwifi.net](http://tplinkwifi.net) (or the router's address, often `192.168.0.1`), then:

1. **Reserve an address:** **Advanced → Network → DHCP Server → Address Reservation → Add**. Pick the Temperance machine and save.
2. **Turn on UPnP:** **Advanced → NAT Forwarding → UPnP**, toggle it on. Some TP-Link models ship with UPnP off.
3. **Or forward by hand:** **Advanced → NAT Forwarding → Virtual Servers → Add** (newer firmware calls it **Port Forwarding**). Enter:
   - Service name: `Temperance`
   - External port: `51820`, internal port: `51820`
   - Internal IP: the address you reserved
   - Protocol: **UDP**
4. **Built-in dynamic DNS (optional):** **Advanced → Network → Dynamic DNS**. TP-Link offers its own TP-Link DDNS, No-IP and DynDNS. Use one of those or Temperance's Dynu updater, not both for the same name.

The router's WAN address is on the **Network Map** (Internet) page. On TP-Link modem routers the same menus live at [tplinkmodem.net](http://tplinkmodem.net).

## TP-Link Deco (mesh, configured in the Deco app)

Port forwarding and UPnP are only available when the Deco works in **Router mode**, not Access Point mode.

1. **Reserve an address:** **More → Advanced → Address Reservation**, add the Temperance machine.
2. **Turn on UPnP:** **More → Advanced → NAT Forwarding → UPnP**, toggle it on.
3. **Or forward by hand:** **More → Advanced → NAT Forwarding → Port Forwarding → Add**. Choose service type **Custom**, name it `Temperance`, tap **Internal IP** and select the Temperance machine (Deco only lets you pick connected devices), enter external port `51820`, leave the internal port blank so it matches, choose **UDP**, and save.
4. **WAN address:** **More → Internet Connection → IPv4**.

Deco's built-in dynamic DNS is TP-Link DDNS only, so use Temperance's Dynu updater for a Dynu name.

## Amazon eero (configured in the eero app)

1. **Reserve an address:** **Settings → Advanced networking → Reservations & port forwarding → Add a reservation**. Choose the Temperance machine.
2. **UPnP:** eero turns UPnP on by default. Check it under **Settings → Advanced networking → UPnP**. Changes there may restart the network.
3. **Or forward by hand:** in **Reservations & port forwarding**, tap the Temperance machine's reservation, tap **Open a port**, enter `51820`, name it `Temperance`, choose **UDP**, and tap **Save**.

eero's built-in dynamic DNS requires an eero Plus subscription; Temperance's Dynu updater works without one.

**eero behind an ISP modem/router.** eero is often installed behind the ISP's own router, which is double NAT. Either put the ISP box in bridge mode, or set eero itself to bridge mode (**Settings → Advanced networking → DHCP & NAT → Bridge**) and do the reservation and port forward on the ISP router instead. In bridge mode eero cannot forward ports or offer UPnP.

## Netgear (Nighthawk and Orbi)

Log in at [routerlogin.net](http://routerlogin.net) (Nighthawk) or [orbilogin.com](http://orbilogin.com) (Orbi) with the admin password. The **Advanced** tab holds everything:

1. **Reserve an address:** **Advanced → Setup → LAN Setup → Address Reservation → Add**. Select the Temperance machine and apply.
2. **Turn on UPnP:** **Advanced → Advanced Setup → UPnP**, check **Turn UPnP On** and apply. Some Orbi models list it under **Advanced → Advanced → UPnP**.
3. **Or forward by hand:** **Advanced → Advanced Setup → Port Forwarding / Port Triggering**. Leave **Port Forwarding** selected, click **Add Custom Service**, and enter:
   - Service name: `Temperance`
   - Protocol: **UDP**
   - External port range: `51820`, with **Use the same port range for Internal port** checked
   - Internal IP address: the address you reserved
   Then click **Apply**. Do not use Port Triggering for this; it only opens ports after outbound traffic.
4. **Built-in dynamic DNS (optional):** **Advanced → Advanced Setup → Dynamic DNS**. Netgear offers its own free NETGEAR (No-IP) names and DynDNS; use Temperance's Dynu updater for a Dynu name.

The router's internet (WAN) address is on the **Advanced** tab's home page.

## Docker hosts

UPnP works from the container only with `network_mode: host` on a Linux host. With the default bridge network or Docker Desktop on macOS and Windows, the router cannot see the container, so forward the port by hand to the Docker host's LAN address as described in [Run with Docker](../README.md#port-forwarding-with-docker). Dynamic DNS works in every setup.

## Still not connecting?

- The dashboard's **Remote access** status explains what the router said. "No UPnP router answered" means UPnP is off on the router, the machine is on a different network segment, or it runs in Docker bridge networking.
- "Already forwards UDP 51820 to another device" means an old rule exists. Delete it in the router's port forwarding list, or point it at the Temperance machine.
- If the status warns about a private internet address, see step 2 of [Before you start](#before-you-start).
- Make sure the machine's own firewall allows UDP 51820 in. The Windows installer adds this rule; on Linux check `ufw` or `firewalld`.
