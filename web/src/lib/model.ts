import type { Profile, Reward, Usage } from "./policy";
export interface Device {
  id: string;
  ip: string;
  name: string;
  profile_id: number;
  public_key: string;
  token_hash: string;
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
  role: "owner" | "parent";
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
export interface State {
  users?: User[];
  refresh_tokens?: RefreshToken[];
  schema: 2;
  version: number;
  nextProfileId: number;
  profiles: Profile[];
  devices: Device[];
  codes: { hash: string; profile_id: number; expires: number }[];
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
