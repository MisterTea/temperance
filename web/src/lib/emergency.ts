import { hashPassword } from "./accounts";
import { secrets } from "./auth";

// A distinct verifier for offline use, never accepted as a dashboard credential.
// Refreshing the operator password invalidates the per-device derivation cache.
let password = "";
const verifiers = new Map<string, Promise<string>>();
export async function emergencyVerifier(deviceId: string) {
  const current = secrets().admin;
  if (current !== password) {
    password = current;
    verifiers.clear();
  }
  let verifier = verifiers.get(deviceId);
  if (!verifier) {
    if (verifiers.size >= 256) verifiers.delete(verifiers.keys().next().value!);
    verifier = hashPassword("Temperance emergency VPN unlock v1\0" + current);
    verifiers.set(deviceId, verifier);
    verifier.catch(() => verifiers.delete(deviceId));
  }
  return verifier;
}
