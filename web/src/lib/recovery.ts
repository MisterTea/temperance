import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

/** Snapshotting and encryption must never block the gateway's 5-second policy loop. */
export async function recoveryJob(command: "backup" | "export") {
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [join(process.cwd(), "scripts", "recovery.cjs"), command],
      {
        env: process.env,
        timeout: 60000,
        maxBuffer: 192 * 1024 * 1024,
        encoding: "utf8",
      },
    );
    return stdout.trim();
  } catch {
    // Child failures can include environment-dependent paths; never return raw stderr.
    throw new Error(
      "Recovery failed. Check SQLite storage, disk space, gateway keys, and the recovery passphrase.",
    );
  }
}
