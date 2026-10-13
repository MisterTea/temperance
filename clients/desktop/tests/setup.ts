import { cleanup } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach } from "vitest";

afterEach(async () => {
  cleanup();
  // Unmounting unsubscribes from events on the next microtask; let it finish
  // before the mocked Tauri internals are removed.
  await Promise.resolve();
  clearMocks();
});
