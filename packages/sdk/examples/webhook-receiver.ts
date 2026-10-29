// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An EventSub webhook receiver on `Bun.serve`: verify the signature and timestamp on the raw body,
 * answer the callback verification with the challenge, drop duplicates (retries reuse the message
 * id), and acknowledge fast (do slow work after answering).
 *
 *   WEBHOOK_SECRET=… PORT=8080 bun examples/webhook-receiver.ts
 *
 * The secret is the one you passed when subscribing (see app-token-webhook.ts).
 */
import { createDedupe, verifyEventSubRequest } from "@commonair/sdk";

const secret = process.env.WEBHOOK_SECRET ?? "";
if (secret.length < 10) throw new Error("set WEBHOOK_SECRET (10-100 characters)");
const seen = createDedupe(10_000);

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8080),
  async fetch(req) {
    if (req.method !== "POST" || new URL(req.url).pathname !== "/hook") return new Response(null, { status: 404 });
    // The signature covers the exact bytes: read the raw text, never re-serialize parsed JSON.
    const rawBody = await req.text();
    const msg = await verifyEventSubRequest({ secret, headers: req.headers, rawBody });
    if (!msg.ok) return new Response(msg.reason, { status: 403 });
    if (msg.messageType === "webhook_callback_verification")
      return new Response(msg.challenge, { headers: { "content-type": "text/plain" } });
    if (!seen.firstSeen(msg.messageId)) return new Response(null, { status: 204 });
    if (msg.messageType === "revocation")
      console.warn(`subscription ${msg.subscription.id} revoked: ${msg.subscription.status}`);
    else queueMicrotask(() => console.warn(`${msg.subscription.type}`, msg.event));
    return new Response(null, { status: 204 });
  },
});
console.warn(`listening on ${server.url}hook`);
