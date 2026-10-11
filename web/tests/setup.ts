import { afterEach } from "vitest";

if (typeof window !== "undefined") {
  const { cleanup, configure } = await import("@testing-library/react");
  configure({ asyncUtilTimeout: 5000 });
  afterEach(cleanup);
  // jsdom does not implement modal dialogs.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
}
