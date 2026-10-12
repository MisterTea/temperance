export declare class GatewayHandle {
  /** Bind the WireGuard socket; forwarding starts once a state is applied. Config is JSON. */
  static start(config: string): GatewayHandle;
  publicKey(): string;
  port(): number;
  /** `service.gatewayState()` as JSON; renews the 15 s forwarding lease. */
  applyState(state: string): void;
  /** `{active_devices, activity, history}` as JSON for `service.account()`. */
  drainActivity(): string;
  stop(): void;
}
export declare function generatePrivateKey(): string;
export declare function publicKey(privateKey: string): string;
