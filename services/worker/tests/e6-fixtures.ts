// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Helpers for the E6 integration tests (exports, deletion, purge); not a test file itself. */
import { coreEnv, instanceSite, loadEnv, type InstanceSite } from "@commonair/config";
import { schema, uuidv7, type Database } from "@commonair/db";
import { DEFAULT_PLATFORM_CUT, paymentSucceeded, post } from "@commonair/ledger";
import { createS3Storage, type ObjectStorage } from "@commonair/storage";

export const MAILPIT_API = process.env.MAILPIT_API_URL ?? "http://localhost:8025";
export const EXPORTS_BUCKET = process.env.S3_BUCKET_EXPORTS ?? "commonair-exports";
export const MEDIA_BUCKET = process.env.S3_BUCKET_MEDIA ?? "commonair-media";

/** The stack's Garage (`.env`), or null when the S3 variables are not set. */
export function stackStorage(): ObjectStorage | null {
  const { S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = process.env;
  if (!S3_ENDPOINT || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) return null;
  return createS3Storage({
    endpoint: S3_ENDPOINT,
    ...(process.env.S3_PUBLIC_ENDPOINT ? { publicEndpoint: process.env.S3_PUBLIC_ENDPOINT } : {}),
    region: process.env.S3_REGION ?? "garage",
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
    forcePathStyle: true,
  });
}

/** Origin the stack's presigned URLs use. */
export const s3PublicOrigin = () => new URL(process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT || "").origin;

export const siteAt = (publicUrl: string): InstanceSite => ({ ...instanceSite(loadEnv(coreEnv, {})), publicUrl });

/** A succeeded tip with its payment and ledger posting (manual provider). */
export async function tip(
  db: Database,
  input: {
    from: string | null;
    channelId: string;
    creatorUserId: string;
    cents: number;
    message: string;
    anonymous?: boolean;
  },
) {
  const tipId = uuidv7();
  const paymentId = uuidv7();
  await db.insert(schema.tips).values({
    id: tipId,
    fromUserId: input.from,
    channelId: input.channelId,
    amountCents: input.cents,
    currency: "usd",
    message: input.message,
    anonymous: input.anonymous ?? false,
    paymentId,
    status: "succeeded",
  });
  await db.insert(schema.payments).values({
    id: paymentId,
    provider: "manual",
    providerRef: `manual_${paymentId}`,
    kind: "tip",
    status: "succeeded",
    userId: input.from,
    channelId: input.channelId,
    tipId,
    amountCents: input.cents,
    feeCents: 0,
    currency: "usd",
    succeededAt: new Date(),
  });
  const { transactionId } = await post(
    db,
    paymentSucceeded({
      paymentId,
      paymentKind: "tip",
      provider: "manual",
      settlement: "receivable",
      creatorUserId: input.creatorUserId,
      grossCents: input.cents,
      taxCents: 0,
      feeCents: 0,
      currency: "usd",
      cut: DEFAULT_PLATFORM_CUT,
      occurredAt: new Date(),
    }),
  );
  return { tipId, paymentId, transactionId };
}

interface MailSummary {
  ID: string;
  To: { Address: string }[];
  Subject: string;
}

/** The newest Mailpit message to `address`, waiting up to 10 s. */
export async function mailTo(address: string): Promise<{ subject: string; html: string; text: string }> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const res = await fetch(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
    if (res.ok) {
      const { messages } = (await res.json()) as { messages: MailSummary[] };
      const found = messages.find((m) => m.To.some((t) => t.Address.toLowerCase() === address.toLowerCase()));
      if (found) {
        const m = (await (await fetch(`${MAILPIT_API}/api/v1/message/${found.ID}`)).json()) as {
          Subject: string;
          HTML: string;
          Text: string;
        };
        return { subject: m.Subject, html: m.HTML, text: m.Text };
      }
    }
    if (Date.now() > deadline) throw new Error("no mail for the recipient within 10 s");
    await Bun.sleep(100);
  }
}

/** Every `href` in an HTML body, entity-decoded. */
export const hrefs = (html: string) =>
  [...html.matchAll(/href="([^"]+)"/g)].map((m) => (m[1] ?? "").replaceAll("&amp;", "&"));
