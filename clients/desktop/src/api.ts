import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Mirrors `Issue`, `Child`, `Screen` and `View` in core/temperance-desktop/src/app.rs. */
export type Issue = { code: string; message: string; action: string };

export type Child = {
  headline: string;
  detail: string;
  remaining: string;
  next_change: string;
  version: number;
  connected: boolean;
  alerts: string[];
  health: Issue[];
  portal_url: string | null;
  can_sign_in: boolean;
  can_ask: boolean;
  pending: boolean;
};

export type Screen =
  | { screen: "choose"; child_allowed: boolean }
  | ({ screen: "child" } & Child)
  | { screen: "parent"; household: string; host: string }
  | { screen: "parent_broken"; error: string };

export type View = { status: string } & Screen;

export type Action =
  | {
      action: "enroll";
      service: string;
      username: string;
      password: string;
      name: string;
    }
  | { action: "connect" }
  | { action: "refresh" }
  | { action: "sign_in" }
  | { action: "open_portal" }
  | { action: "request_time"; minutes: number; message: string }
  | { action: "pair_parent"; link: string; name: string }
  | { action: "open_dashboard" }
  | { action: "unpair_parent" };

export const view = () => invoke<View>("view");
export const act = (action: Action) => invoke<View>("act", { action });
/** The app pushes a fresh view every few seconds; returns the unsubscribe. */
export const onView = (handle: (view: View) => void) =>
  listen<View>("view", (event) => handle(event.payload));
