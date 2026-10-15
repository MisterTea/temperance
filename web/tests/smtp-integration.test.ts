import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import { createSecureContext, TLSSocket } from "node:tls";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { smtpSend } from "../src/lib/notifications";

let directory: string;
let key: Buffer, cert: Buffer;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "temperance-smtp-"));
  // Test-only trust root, generated at runtime; never disable TLS verification.
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "ca.pem"),
    ],
    { stdio: "ignore" },
  );
  [key, cert] = await Promise.all([
    readFile(join(directory, "key.pem")),
    readFile(join(directory, "ca.pem")),
  ]);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function server({ advertiseTLS = true, refuseRecipient = false } = {}) {
  const sockets = new Set<Socket>();
  const messages: string[] = [];
  const commands: { line: string; encrypted: boolean }[] = [];
  const context = createSecureContext({ key, cert });
  const smtp = createServer((raw) => {
    sockets.add(raw);
    raw.on("close", () => sockets.delete(raw));
    raw.on("error", () => undefined);
    function attach(socket: Socket, encrypted: boolean) {
      let input = "",
        data = false,
        message = "";
      const consume = (chunk: Buffer) => {
        input += chunk.toString();
        while (input.includes("\r\n")) {
          const end = input.indexOf("\r\n");
          const line = input.slice(0, end);
          input = input.slice(end + 2);
          if (data) {
            if (line === ".") {
              messages.push(message);
              data = false;
              socket.write("250 accepted\r\n");
            } else message += line + "\n";
            continue;
          }
          commands.push({ line, encrypted });
          if (/^(EHLO|HELO)/.test(line))
            socket.write(
              `250-test\r\n${!encrypted && advertiseTLS ? "250-STARTTLS\r\n" : ""}${encrypted ? "250-AUTH PLAIN\r\n" : ""}250 OK\r\n`,
            );
          else if (line === "STARTTLS" && advertiseTLS) {
            socket.removeListener("data", consume);
            socket.write("220 upgrade\r\n", () => {
              const secure = new TLSSocket(raw, {
                isServer: true,
                secureContext: context,
              });
              secure.on("error", () => undefined);
              attach(secure, true);
            });
            return;
          } else if (/^AUTH PLAIN/.test(line))
            socket.write("235 authenticated\r\n");
          else if (/^MAIL FROM:/.test(line))
            socket.write("250 sender accepted\r\n");
          else if (/^RCPT TO:/.test(line))
            socket.write(
              refuseRecipient
                ? "550 recipient refused\r\n"
                : "250 recipient accepted\r\n",
            );
          else if (line === "DATA") {
            data = true;
            message = "";
            socket.write("354 send message\r\n");
          } else if (line === "QUIT") socket.end("221 bye\r\n");
          else socket.write("502 unsupported\r\n");
        }
      };
      socket.on("data", consume);
    }
    attach(raw, false);
    raw.write("220 test SMTP ready\r\n");
  });
  await new Promise<void>((resolve, reject) => {
    smtp.once("error", reject);
    smtp.listen(0, "127.0.0.1", resolve);
  });
  const address = smtp.address();
  if (!address || typeof address === "string") throw new Error("No SMTP port");
  vi.stubEnv("TEMPERANCE_SMTP_HOST", "127.0.0.1");
  vi.stubEnv("TEMPERANCE_SMTP_PORT", String(address.port));
  vi.stubEnv("TEMPERANCE_SMTP_FROM", "temperance@example.test");
  vi.stubEnv("TEMPERANCE_SMTP_TO", "admin@example.test");
  vi.stubEnv("TEMPERANCE_SMTP_USER", "");
  vi.stubEnv("TEMPERANCE_SMTP_PASSWORD", "");
  vi.stubEnv("TEMPERANCE_SMTP_CA_FILE", join(directory, "ca.pem"));
  return {
    messages,
    commands,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => smtp.close(() => resolve()));
    },
  };
}
const notice = {
  id: "synthetic-notice",
  subject: "Temperance needs your attention",
  text: "A time request needs your attention.",
};
it("delivers through real STARTTLS with trusted certificates and stable Message-ID", async () => {
  const smtp = await server();
  vi.stubEnv("TEMPERANCE_SMTP_USER", "synthetic-user");
  vi.stubEnv("TEMPERANCE_SMTP_PASSWORD", "synthetic-password");
  try {
    await smtpSend(notice);
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]).toContain(
      "Message-ID: <synthetic-notice@temperance.local>",
    );
    expect(smtp.messages[0]).toContain(notice.text);
    expect(
      smtp.commands
        .filter((c) => /^(MAIL|RCPT|DATA)/.test(c.line))
        .every((c) => c.encrypted),
    ).toBe(true);
    expect(
      smtp.commands.find((c) => /^AUTH PLAIN/.test(c.line))?.encrypted,
    ).toBe(true);
  } finally {
    await smtp.close();
  }
});
it("refuses untrusted certificates before sending mail", async () => {
  const smtp = await server();
  vi.stubEnv("TEMPERANCE_SMTP_CA_FILE", "");
  try {
    await expect(smtpSend(notice)).rejects.toThrow();
    expect(smtp.messages).toHaveLength(0);
  } finally {
    await smtp.close();
  }
});
it("requires STARTTLS and propagates recipient rejection", async () => {
  const plain = await server({ advertiseTLS: false });
  try {
    await expect(smtpSend(notice)).rejects.toThrow();
    expect(plain.messages).toHaveLength(0);
  } finally {
    await plain.close();
  }
  const refusing = await server({ refuseRecipient: true });
  try {
    await expect(smtpSend(notice)).rejects.toThrow();
    expect(refusing.messages).toHaveLength(0);
  } finally {
    await refusing.close();
  }
});
