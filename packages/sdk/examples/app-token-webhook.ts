// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A confidential app subscribes a webhook with an app token (client credentials): no user, no
 * scopes, so only scope-free events (like `channel.follow`) for any broadcaster, or scoped events
 * of broadcasters who authorized the app. Run webhook-receiver.ts at `CALLBACK_URL` first: the
 * subscription turns `enabled` once it answers the challenge.
 *
 *   COMMONAIR_URL=… COMMONAIR_CLIENT_ID=… COMMONAIR_CLIENT_SECRET=… BROADCASTER_ID=… \
 *     CALLBACK_URL=https://bot.example.org/hook WEBHOOK_SECRET=… bun examples/app-token-webhook.ts
 */
import { clientCredentials, createClient, errorCode } from "@commonair/sdk";

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name}`);
  return v;
};
const baseUrl = process.env.COMMONAIR_URL ?? "http://localhost:3001";

const app = await clientCredentials({
  baseUrl,
  clientId: env("COMMONAIR_CLIENT_ID"),
  clientSecret: env("COMMONAIR_CLIENT_SECRET"),
});
const client = createClient({ baseUrl, token: app.accessToken });

try {
  const sub = await client.developer.events.subscribe({
    type: "channel.follow",
    version: "1",
    condition: { broadcaster_user_id: env("BROADCASTER_ID") },
    transport: { method: "webhook", callback: env("CALLBACK_URL"), secret: env("WEBHOOK_SECRET") },
  });
  console.warn(`subscription ${sub.id}: ${sub.status}`);
} catch (err) {
  // FORBIDDEN: a scoped event of a broadcaster who never authorized the app; PRECONDITION_FAILED: see `data.requirement`.
  console.error(`subscribe refused: ${errorCode(err) ?? String(err)}`);
  process.exit(1);
}
