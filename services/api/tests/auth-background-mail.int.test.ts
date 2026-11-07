// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Auth mail never holds the request (auth/background.ts). Before better-auth's background-task
 * handler was set, sign-up awaited the verification mail and all its retries: with Mailpit's
 * connects timing out, the harness's 15 s sign-up call timed out (CI run 42244605154). Here the
 * mailer never answers at all; every endpoint must still return, and the send must still start.
 */
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import type { Mailer } from "@commonair/email";
import { createAuth } from "../src/auth/index.ts";
import { authBackground } from "../src/auth/background.ts";
import { solveAltcha, startApi, uniqueName, type TestApi } from "./harness.ts";

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
}, 60_000);
afterAll(async () => {
  await api?.stop();
});

/** Records each send and never settles it, like an SMTP server that accepts the TCP connect and then stalls. */
function stalledMailer() {
  const sends: { template: string; to: string }[] = [];
  const mailer: Mailer = {
    send: (template, _props, to) => {
      sends.push({ template, to });
      return new Promise<string>(() => {});
    },
    close: async () => {},
  };
  return { mailer, sends };
}

/** The handler's answer, or a marker if it is still waiting after `ms` (it waited on the mail). */
async function answered(res: Promise<Response>, ms = 10_000): Promise<Response | "still waiting"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"still waiting">((resolve) => (timer = setTimeout(() => resolve("still waiting"), ms)));
  try {
    return await Promise.race([res, late]);
  } finally {
    clearTimeout(timer);
  }
}

test("sign-up, verification resend, password reset and magic link answer while the mail server stalls", async () => {
  const { mailer, sends } = stalledMailer();
  const background = authBackground(api.deps.logger);
  const auth = createAuth({ ...api.deps, mailer }, { background });
  const post = (path: string, body: unknown) =>
    auth.handler(
      new Request(`${api.url}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000" },
        body: JSON.stringify(body),
      }),
    );
  const username = uniqueName();
  const email = `${username}@test.invalid`;

  const up = await answered(
    post("/sign-up/email", {
      email,
      password: `pw-${crypto.randomUUID()}`,
      name: username,
      username,
      birthDate: "1990-05-05",
      altcha: await solveAltcha(api),
    }),
  );
  expect(up === "still waiting" ? up : up.status).toBe(200);
  expect(sends).toEqual([{ template: "verifyEmail", to: email }]);
  // The stalled send is tracked (better-auth's own deferred wrapper may still be settling too).
  expect(background.pending()).toBeGreaterThanOrEqual(1);

  const resend = await answered(post("/send-verification-email", { email }));
  expect(resend === "still waiting" ? resend : resend.status).toBe(200);
  expect(sends.at(-1)).toEqual({ template: "verifyEmail", to: email });

  const reset = await answered(
    post("/request-password-reset", { email, redirectTo: `${api.deps.site.publicUrl}/reset` }),
  );
  expect(reset === "still waiting" ? reset : reset.status).toBe(200);
  expect(sends.at(-1)).toEqual({ template: "passwordReset", to: email });

  const magic = await answered(post("/sign-in/magic-link", { email, callbackURL: `${api.deps.site.publicUrl}/` }));
  expect(magic === "still waiting" ? magic : magic.status).toBe(200);
  expect(sends.at(-1)).toEqual({ template: "magicLink", to: email });

  // Every send is still running, tracked rather than awaited by a request.
  expect(sends).toHaveLength(4);
  expect(background.pending()).toBeGreaterThanOrEqual(4);
});

test("a failed verification mail is logged without the address and the sign-up still succeeds", async () => {
  const lines: string[] = [];
  const logger = {
    ...api.deps.logger,
    error: (msg: string, fields?: Record<string, unknown>) => void lines.push(JSON.stringify({ msg, ...fields })),
  };
  const username = uniqueName();
  const email = `${username}@test.invalid`;
  const mailer: Mailer = {
    send: async () => {
      throw Object.assign(new Error(`550 mailbox ${email} unavailable`), { code: "EENVELOPE", responseCode: 550 });
    },
    close: async () => {},
  };
  const background = authBackground(logger);
  const auth = createAuth({ ...api.deps, logger, mailer }, { background });
  const res = await auth.handler(
    new Request(`${api.url}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({
        email,
        password: `pw-${crypto.randomUUID()}`,
        name: username,
        username,
        birthDate: "1990-05-05",
        altcha: await solveAltcha(api),
      }),
    }),
  );
  expect(res.status).toBe(200);
  await background.drain();
  expect(background.pending()).toBe(0);
  const failed = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === "auth mail failed");
  expect(failed).toMatchObject({ template: "verifyEmail", code: "EENVELOPE", responseCode: 550 });
  expect(lines.join("")).not.toContain(email);
});
