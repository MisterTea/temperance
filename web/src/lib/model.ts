import type { Profile, Reward, Usage } from "./policy";
export interface Device {
  id: string;
  /** Home devices cannot run the VPN app; the gateway enforces them by LAN address. */
  kind?: "home";
  ip: string;
  name: string;
  profile_id: number;
  /** An admin's own device. It is not a client's device and cannot be turned into one. */
  admin?: boolean;
  public_key: string;
  token_hash: string;
  /** IAM user who registered this VPN client. */
  user_id?: string;
  revoked: boolean;
  paused: boolean;
  managed: boolean;
  last_seen?: number;
  location?: {
    latitude: number;
    longitude: number;
    accuracy: number;
    at: number;
  };
  location_requested?: number;
  /** Latest connectivity/permission issues the device reported (shared Rust `diagnose`). */
  diagnostics?: { at: number; issues: DeviceIssue[] };
}
export interface DeviceIssue {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  action: string;
}
export interface History {
  id: string;
  at: number;
  device_id: string;
  profile_id: number;
  domain: string;
  blocked: boolean;
  reason: string;
  category: string;
}
export interface TimeRequest {
  id: string;
  device_id: string;
  profile_id: number;
  minutes: number;
  message: string;
  status: "pending" | "approved" | "denied";
  at: number;
}
export interface Event {
  id: string;
  at: number;
  kind: string;
  message: string;
  read: boolean;
}
export interface User {
  id: string;
  username: string;
  password_hash: string;
  /**
   * `user` is a client's sign-in. `owner` is the account created from the admin
   * password. `parent` is not used for new accounts: a paired admin device is a
   * `Parent` record, not this role.
   */
  role: "user" | "owner" | "parent";
  profile_id?: number;
  disabled?: boolean;
  session_version: number;
  created_at: number;
  failed_logins: number;
  locked_until?: number;
}
export interface RefreshToken {
  hash: string;
  user_id: string;
  client_id: string;
  expires: number;
}
export interface DynuSettings {
  provider: "dynu";
  hostname: string;
  username: string;
  /** Dynu's IP update password; only the gateway ever receives it. */
  password: string;
}
/** How the gateway makes itself reachable from outside the home. */
export interface NetworkSettings {
  upnp: boolean;
  ddns?: DynuSettings;
}
export interface ReachStatus {
  state: "ok" | "warning" | "error" | "off";
  ip: string | null;
  message: string;
  at: number;
}
export interface NetworkStatus {
  upnp: ReachStatus | null;
  ddns: ReachStatus | null;
  reported_at: number;
}
/** An admin's phone paired to open the dashboard through the gateway. The wire name stays `parent`. */
export interface Parent {
  id: string;
  name: string;
  /** Fingerprint of the phone's key, as the gateway sees it. */
  key: string;
  created_at: number;
  last_seen?: number;
  revoked?: boolean;
}
export interface State {
  /** Local maintenance metadata; never part of the native policy protocol. */
  maintenance?: {
    update?: UpdateAttempt;
    mail?: {
      initialized_at: number;
      deliveries: {
        id: string;
        kind?: string;
        attempts: number;
        next_at: number;
        sent_at?: number;
        failed?: boolean;
      }[];
      last_sent_at?: number;
      last_error?: string;
    };
    feeds?: Record<
      string,
      { checked_at: number; updated_at?: number; count: number; error?: string }
    >;
    gateway_offline?: boolean;
    backup_at?: number;
    backup_error?: string;
  };
  users?: User[];
  refresh_tokens?: RefreshToken[];
  schema: 2;
  version: number;
  nextProfileId: number;
  profiles: Profile[];
  devices: Device[];
  codes: {
    hash: string;
    profile_id: number;
    admin?: boolean;
    expires: number;
  }[];
  rewards: Reward[];
  usage: Usage;
  history: History[];
  requests: TimeRequest[];
  events: Event[];
  paused: boolean;
  home_profile_id?: number;
  extra_domains: Record<string, string[]>;
  retention_days: number;
  offline_grace_seconds: number;
  gateway_seen?: number;
  /** Unset means UPnP on and no dynamic DNS. */
  network?: NetworkSettings;
  /** The gateway's latest report on UPnP and dynamic DNS. */
  network_status?: NetworkStatus;
  parents?: Parent[];
  parent_codes?: { hash: string; expires: number }[];
  /** Fingerprint of the gateway's key for parent phones, as it last reported. */
  remote_pin?: string;
  /** Set when the first-run wizard is finished or skipped. */
  setup_completed_at?: number;
}
export interface UpdateAttempt {
  id: string;
  from: string;
  target: string;
  status: "preparing" | "dispatched" | "succeeded" | "failed";
  requested_at: number;
  deadline_at: number;
  finished_at?: number;
  message?: string;
}
export const emptyState = (): State => ({
  schema: 2,
  version: 1,
  nextProfileId: 1,
  profiles: [],
  devices: [],
  codes: [],
  rewards: [],
  usage: {},
  history: [],
  requests: [],
  events: [],
  paused: false,
  extra_domains: {},
  retention_days: 30,
  offline_grace_seconds: 86400,
});
