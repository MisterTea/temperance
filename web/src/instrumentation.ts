// Runs once per server process. With TEMPERANCE_GATEWAY_LISTEN set, this
// process is also the household's WireGuard gateway.
export async function register() {
  if (
    process.env.NEXT_RUNTIME !== "nodejs" ||
    !process.env.TEMPERANCE_GATEWAY_LISTEN
  )
    return;
  const { startGateway } = await import("./lib/gateway");
  const gateway = await startGateway();
  console.log(
    `Temperance gateway on udp ${process.env.TEMPERANCE_GATEWAY_LISTEN}, public key ${gateway.publicKey}`,
  );
}
