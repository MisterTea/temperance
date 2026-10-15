// Runs once per server process. With TEMPERANCE_GATEWAY_LISTEN set, this
// process is also the household's WireGuard gateway.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.TEMPERANCE_GATEWAY_LISTEN) {
    const { startGateway } = await import("./lib/gateway");
    const gateway = await startGateway();
    console.log(
      `Temperance gateway on udp ${process.env.TEMPERANCE_GATEWAY_LISTEN}, public key ${gateway.publicKey}`,
    );
  }
  // Long-lived maintenance belongs to a persistent Node server, not a Worker or
  // request-scoped serverless function. Remote Node operators can opt in.
  if (
    !process.env.TEMPERANCE_GATEWAY_LISTEN &&
    process.env.TEMPERANCE_MAINTENANCE !== "on"
  )
    return;
  const { startMaintenance } = await import("./lib/maintenance");
  const { repository } = await import("./lib/database");
  startMaintenance(repository());
}
