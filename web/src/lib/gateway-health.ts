type GatewayHealth = {
  applied_at?: number;
  sync_failures: number;
  syncs: number;
};
const runtime = globalThis as typeof globalThis & {
  temperanceGatewayHealth?: GatewayHealth;
};
export function gatewayHealth() {
  return (runtime.temperanceGatewayHealth ??= { sync_failures: 0, syncs: 0 });
}
