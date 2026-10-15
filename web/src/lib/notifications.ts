import { z } from "zod";
import { mutate, type Repository } from "./database";
import type { State } from "./model";

const NOTICE: Record<string, string> = {
  time_request: "A time request needs your attention or has been answered.",
  new_device: "A device was added to your household.",
  device: "A device was changed or removed.",
  device_health: "A device reported a protection problem.",
  account: "Household administration changed.",
  gateway: "Gateway connectivity changed.",
  network: "Remote access needs your attention.",
};
export type Mail = { id: string; subject: string; text: string };
export type SendMail = (mail: Mail) => Promise<void>;
export function mailConfig(env = process.env) {
  if (!env.TEMPERANCE_SMTP_HOST) return null;
  return z
    .object({
      host: z
        .string()
        .min(1)
        .max(253)
        .regex(/^[a-zA-Z0-9.:-]+$/),
      port: z.coerce.number().int().min(1).max(65535),
      from: z.email(),
      to: z.email(),
    })
    .parse({
      host: env.TEMPERANCE_SMTP_HOST,
      port: env.TEMPERANCE_SMTP_PORT || 587,
      from: env.TEMPERANCE_SMTP_FROM,
      to: env.TEMPERANCE_SMTP_TO,
    });
}
export const smtpSend: SendMail = async (mail) => {
  const config = mailConfig();
  if (!config) throw new Error("Configure SMTP on the server first.");
  const { default: nodemailer } = await import("nodemailer");
  const ca = process.env.TEMPERANCE_SMTP_CA_FILE
    ? await (
        await import("node:fs/promises")
      ).readFile(process.env.TEMPERANCE_SMTP_CA_FILE)
    : undefined;
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    requireTLS: config.port !== 465,
    tls: ca ? { ca } : undefined,
    auth: process.env.TEMPERANCE_SMTP_USER
      ? {
          user: process.env.TEMPERANCE_SMTP_USER,
          pass: process.env.TEMPERANCE_SMTP_PASSWORD || "",
        }
      : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
    disableFileAccess: true,
    disableUrlAccess: true,
    name: "temperance",
    logger: false,
    debug: false,
  });
  try {
    const result = await transport.sendMail({
      from: config.from,
      to: config.to,
      subject: mail.subject,
      text: mail.text,
      messageId: `<${mail.id}@temperance.local>`,
    });
    if (!result.accepted?.length || result.rejected?.length)
      throw new Error("Recipient refused");
  } finally {
    transport.close();
  }
};
function message(id: string, text: string): Mail {
  // Never include free-form device/client names, request text, addresses or credentials.
  return {
    id,
    subject: "Temperance needs your attention",
    text: `${text}\n\nOpen your paired admin app or your household dashboard to review it. Email does not grant access or approve requests.`,
  };
}
export function notificationStatus(state: State) {
  const mail = state.maintenance?.mail;
  let configured = false;
  try {
    configured = !!mailConfig();
  } catch {
    /* The settings UI reports incomplete configuration. */
  }
  return {
    configured,
    worker_enabled:
      !!process.env.TEMPERANCE_GATEWAY_LISTEN ||
      process.env.TEMPERANCE_MAINTENANCE === "on",
    enabled: !!process.env.TEMPERANCE_SMTP_HOST,
    last_sent_at: mail?.last_sent_at ?? null,
    error: mail?.last_error ?? null,
    pending:
      mail?.deliveries.filter((d) => !d.sent_at && !d.failed).length ?? 0,
    failed: mail?.deliveries.filter((d) => d.failed).length ?? 0,
  };
}
export async function testMail(
  repo: Repository,
  send = smtpSend,
  at = Math.floor(Date.now() / 1000),
) {
  const claimed = await mutate(repo, (state) => {
    const mail = state.maintenance?.mail;
    if (!mail) return false;
    // A durable reservation also rate limits tests across concurrent requests.
    if (
      mail.deliveries.some(
        (d) => d.id.startsWith("test-") && at - d.next_at < 60,
      )
    )
      return false;
    mail.deliveries.push({
      id: `test-${crypto.randomUUID()}`,
      attempts: 1,
      next_at: at,
      sent_at: at,
    });
    return true;
  });
  if (!claimed)
    throw new Error(
      "Email worker is not ready, or a test was requested in the last minute.",
    );
  try {
    await send(
      message(crypto.randomUUID(), "This is your requested delivery test."),
    );
    await mutate(repo, (state) => {
      const mail = state.maintenance!.mail!;
      mail.last_sent_at = at;
      delete mail.last_error;
    });
  } catch {
    await mutate(repo, (state) => {
      state.maintenance!.mail!.last_error =
        "Email delivery failed. Check SMTP settings and recipient access, then test again.";
    });
    throw new Error(
      "Email delivery failed. Check SMTP settings and recipient access.",
    );
  }
}
export async function retryFailedNotifications(
  repo: Repository,
  at = Math.floor(Date.now() / 1000),
) {
  if (!mailConfig()) throw new Error("Configure SMTP before retrying email.");
  return mutate(repo, (s) => {
    const mail = s.maintenance?.mail;
    if (!mail) return { retried: 0 };
    let retried = 0;
    for (const d of mail.deliveries) {
      if (!d.failed || d.sent_at) continue;
      const kind = d.kind || s.events.find((e) => e.id === d.id)?.kind;
      if (!kind || !NOTICE[kind]) continue;
      d.kind = kind;
      d.attempts = 0;
      d.next_at = at;
      delete d.failed;
      retried++;
    }
    return { retried };
  });
}
export async function deliverNotifications(
  repo: Repository,
  send = smtpSend,
  at = Math.floor(Date.now() / 1000),
) {
  if (!mailConfig()) return;
  await mutate(repo, (state) => {
    const maintenance = (state.maintenance ??= {});
    if (!maintenance.mail) {
      // Enabling mail must not send a household's historical events.
      maintenance.mail = {
        initialized_at: at,
        deliveries: state.events.map((e) => ({
          id: e.id,
          attempts: 0,
          next_at: at,
          sent_at: at,
        })),
      };
      return;
    }
    const mail = maintenance.mail;
    const events = new Set(state.events.map((e) => e.id));
    mail.deliveries = mail.deliveries
      .filter(
        (d) =>
          events.has(d.id) ||
          (!d.sent_at && (!d.failed || !!d.kind)) ||
          (d.id.startsWith("test-") && at - d.next_at < 60),
      )
      .slice(-1000);
    for (const e of state.events)
      if (
        e.at >= mail.initialized_at &&
        NOTICE[e.kind] &&
        !mail.deliveries.some((d) => d.id === e.id)
      )
        mail.deliveries.push({
          id: e.id,
          kind: e.kind,
          attempts: 0,
          next_at: at,
        });
  });
  // Bound the work per tick. SMTP side effects are never executed inside retried transactions.
  for (let i = 0; i < 5; i++) {
    const claimed = await mutate(repo, (state) => {
      const mail = state.maintenance!.mail!;
      // Legacy queues may refer to a pruned event. Skip those without starving
      // the remaining queue; new entries retain only the generic event kind.
      for (const delivery of mail.deliveries) {
        if (delivery.sent_at || delivery.failed || delivery.next_at > at)
          continue;
        const kind =
          delivery.kind || state.events.find((e) => e.id === delivery.id)?.kind;
        if (!kind || !NOTICE[kind]) {
          delivery.failed = true;
          continue;
        }
        delivery.kind = kind;
        delivery.attempts++;
        delivery.next_at = at + 120;
        return {
          id: delivery.id,
          text: NOTICE[kind],
          attempts: delivery.attempts,
        };
      }
      return null;
    });
    if (!claimed) break;
    try {
      await send(message(claimed.id, claimed.text));
      await mutate(repo, (state) => {
        const mail = state.maintenance!.mail!;
        const delivery = mail.deliveries.find((d) => d.id === claimed.id);
        if (delivery) delivery.sent_at = at;
        mail.last_sent_at = at;
        delete mail.last_error;
      });
    } catch {
      await mutate(repo, (state) => {
        const mail = state.maintenance!.mail!;
        const delivery = mail.deliveries.find((d) => d.id === claimed.id);
        if (delivery) {
          delivery.next_at = at + Math.min(3600, 60 * 2 ** claimed.attempts);
          delivery.failed = claimed.attempts >= 5;
        }
        mail.last_error =
          "Email delivery failed. Check SMTP settings and recipient access, then test again.";
      });
    }
  }
}
