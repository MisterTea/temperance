// The access point's subnet. The dashboard assigns each TV a fixed address
// on it. Without an access point, a home device cannot be added.
type Env = Record<string, string | undefined>;

export type HomeNetwork = {
  gateway: string;
  prefix: number;
  mask: string;
  /** Empty when DNS on this network is turned off. */
  dns: string;
  ssid?: string;
  passphrase?: string;
};

export function accessPoint(value: string | undefined) {
  const spec = value?.trim();
  if (!spec) return null;
  const fields = spec.split(";");
  if (fields.length < 4)
    throw new Error(
      "TEMPERANCE_GATEWAY_AP is interface;address/prefix;ssid;passphrase",
    );
  const iface = fields[0].trim();
  const cidr = fields[1].trim();
  const ssid = fields[2].trim();
  const passphrase = fields.slice(3).join(";");
  const [address, prefixText] = cidr.split("/");
  const prefix = Number(prefixText);
  if (
    !iface ||
    !address ||
    !ssid ||
    ssid.length > 32 ||
    passphrase.length < 8 ||
    passphrase.length > 63 ||
    !Number.isInteger(prefix) ||
    prefix < 8 ||
    prefix > 30
  )
    throw new Error(
      "TEMPERANCE_GATEWAY_AP is interface;address/prefix;ssid;passphrase",
    );
  return { interface: iface, address, prefix, ssid, passphrase, dns: true };
}

export function ipv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    n = ((n << 8) + value) >>> 0;
  }
  return n;
}

export function formatIpv4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

function maskBits(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

export function subnetMask(prefix: number): string {
  return formatIpv4(maskBits(prefix));
}

export function inNetwork(ip: string, gateway: string, prefix: number): boolean {
  const address = ipv4(ip);
  const base = ipv4(gateway);
  if (address === null || base === null || prefix < 0 || prefix > 32) return false;
  const mask = maskBits(prefix);
  return (address & mask) === (base & mask);
}

function dnsAddress(setting: string | undefined, gateway: string): string {
  const value = setting?.trim();
  if (value === "off") return "";
  if (!value || value.startsWith("0.0.0.0:")) return gateway;
  const host = value.split(":")[0];
  return ipv4(host) !== null ? host : gateway;
}

/** The access point's subnet, gateway and DNS. Null when access point mode is off. */
export function homeNetwork(env: Env = process.env): HomeNetwork | null {
  const ap = accessPoint(env.TEMPERANCE_GATEWAY_AP);
  if (!ap) return null;
  return {
    gateway: ap.address,
    prefix: ap.prefix,
    mask: subnetMask(ap.prefix),
    dns: dnsAddress(env.TEMPERANCE_GATEWAY_HOME_DNS, ap.address),
    ssid: ap.ssid,
    passphrase: ap.passphrase,
  };
}

/** Next address on the home network, skipping the gateway, network and broadcast. */
export function nextHomeAddress(
  net: { gateway: string; prefix: number },
  used: Iterable<string>,
): string | null {
  const gateway = ipv4(net.gateway);
  if (gateway === null || net.prefix < 8 || net.prefix > 30) return null;
  const mask = maskBits(net.prefix);
  const base = (gateway & mask) >>> 0;
  const size = 2 ** (32 - net.prefix);
  const taken = new Set(used);
  for (let host = 1; host < size - 1; host++) {
    const address = (base + host) >>> 0;
    if (address === gateway) continue;
    const text = formatIpv4(address);
    if (!taken.has(text)) return text;
  }
  return null;
}
