// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Work that runs after better-auth has answered: verification, reset and magic-link mail.
 *
 * Without `advanced.backgroundTasks.handler`, better-auth's `runInBackgroundOrAwait` awaits the
 * send, so sign-up held the request for the SMTP connect and every retry (`retryingMailer`: 1 s,
 * 3 s, 10 s), past a client's deadline whenever the mail server was slow. Some routes never go
 * through that helper and await our callback directly (`/send-verification-email`, the magic-link
 * plugin), so each auth mail callback also detaches its send here instead of returning it. The
 * request no longer waits on SMTP, which also keeps a reset for an existing address as fast as
 * one for an unknown address.
 */
import type { Logger } from "@commonair/observability";

export interface AuthBackground {
  /** better-auth's `advanced.backgroundTasks.handler`: keeps the task, never awaits it. */
  handler(task: Promise<unknown>): void;
  /**
   * Starts one auth mail and returns at once. A failure is logged here with the template and the
   * error's codes, never the address (better-auth's own logger prints the whole error, whose
   * message can quote the recipient).
   */
  mail(template: string, send: () => Promise<unknown>): void;
  /** Tasks that have not settled. */
  pending(): number;
  /** Resolves once every task started so far has settled. */
  drain(): Promise<void>;
}

/** Error fields safe to log: the error's name, nodemailer's codes and the SMTP reply code. */
function errorFields(err: unknown): Record<string, unknown> {
  if (typeof err !== "object" || err === null) return { err: typeof err };
  const e = err as { name?: unknown; code?: unknown; command?: unknown; responseCode?: unknown };
  return {
    err: typeof e.name === "string" ? e.name : "Error",
    ...(typeof e.code === "string" ? { code: e.code } : {}),
    ...(typeof e.command === "string" ? { command: e.command } : {}),
    ...(typeof e.responseCode === "number" ? { responseCode: e.responseCode } : {}),
  };
}

export function authBackground(logger: Logger): AuthBackground {
  const tasks = new Set<Promise<void>>();
  const track = (task: Promise<unknown>, onError: (err: unknown) => void) => {
    const tracked: Promise<void> = task.then(() => undefined, onError).finally(() => tasks.delete(tracked));
    tasks.add(tracked);
  };
  return {
    handler(task) {
      track(task, (err) => logger.error("auth background task failed", errorFields(err)));
    },
    mail(template, send) {
      // `send` may throw before it returns a promise; that must not reach the request either.
      track(Promise.resolve().then(send), (err) => logger.error("auth mail failed", { template, ...errorFields(err) }));
    },
    pending: () => tasks.size,
    async drain() {
      await Promise.all(tasks);
    },
  };
}
