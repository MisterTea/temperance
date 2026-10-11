export async function hash(value: string) {
  const data = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(data)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export function randomToken() {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export function validateKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9+/]{43}=$/.test(value) ||
    Uint8Array.from(atob(value), (c) => c.charCodeAt(0)).every((n) => n === 0)
  )
    throw new Error("Invalid WireGuard public key");
  return value;
}
export function secrets() {
  const admin = process.env.TEMPERANCE_ADMIN_TOKEN ?? "",
    gateway = process.env.TEMPERANCE_GATEWAY_TOKEN ?? "";
  if (admin.length < 32 || gateway.length < 32 || admin === gateway)
    throw new Error(
      "Configure distinct admin/gateway secrets of at least 32 characters",
    );
  return { admin, gateway };
}
export function bearer(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}
export function origin() {
  const value = process.env.TEMPERANCE_PUBLIC_URL;
  if (!value) throw new Error("Configure TEMPERANCE_PUBLIC_URL");
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(url.hostname)
  )
    throw new Error("Remote public origin must use HTTPS");
  return url.origin;
}
