// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Regenerate vectors.json (`bun run vectors`). RSASSA-PKCS1-v1_5 is deterministic and every
 * input is fixed, so the output is stable. The requests have the shape of Mastodon's documented
 * examples (POST to an inbox with `Host`, `Date`, `Digest` and a `Signature` over
 * `(request-target) host date digest`); the tamper cases each break one rule. Test keys only.
 */
import { publicKeyPemFromPrivate } from "./keys.ts";
import { type SignatureError, signRequest } from "./signature.ts";
import testKeys from "./test-keys.json" with { type: "json" };

export function pkcs8Pem(b64: string): string {
  return `-----BEGIN PRIVATE KEY-----\n${(b64.match(/.{1,64}/g) ?? []).join("\n")}\n-----END PRIVATE KEY-----\n`;
}

export const KEYS = { actor: pkcs8Pem(testKeys.actor), other: pkcs8Pem(testKeys.other) } as const;
export type KeyName = keyof typeof KEYS;

export const DATE = "Sun, 05 Jan 2025 21:31:40 GMT";
/** One minute after `DATE`. */
export const NOW = "2025-01-05T21:32:40.000Z";

const remoteActor = "https://mastodon.example/users/alice";
const channel = "https://instance.example/ap/channels/01890000-0000-7000-8000-00000000c001";

const follow = JSON.stringify({
  "@context": "https://www.w3.org/ns/activitystreams",
  id: "https://mastodon.example/a1b2c3d4",
  type: "Follow",
  actor: remoteActor,
  object: channel,
});
const undo = JSON.stringify({
  "@context": "https://www.w3.org/ns/activitystreams",
  id: "https://mastodon.example/users/alice#follows/1/undo",
  type: "Undo",
  actor: remoteActor,
  object: { id: "https://mastodon.example/a1b2c3d4", type: "Follow", actor: remoteActor, object: channel },
});
const accept = JSON.stringify({
  "@context": "https://www.w3.org/ns/activitystreams",
  id: `${channel}#accepts/follows/1`,
  type: "Accept",
  actor: channel,
  object: { id: "https://mastodon.example/a1b2c3d4", type: "Follow", actor: remoteActor, object: channel },
});

export interface VectorRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface Vector {
  name: string;
  request: VectorRequest;
  verify: { now: string; key: KeyName; actorId?: string };
  /** "ok", or the error `verifyRequest` must return. */
  expect: "ok" | SignatureError;
  /** For the "ok" cases signed here: the exact string that was signed. */
  signingString?: string;
}

async function signed(method: string, url: string, keyId: string, body?: string): Promise<VectorRequest> {
  const headers = await signRequest({
    method,
    url,
    headers:
      body === undefined
        ? { accept: "application/activity+json" }
        : { "content-type": 'application/activity+json; profile="https://www.w3.org/ns/activitystreams"' },
    body,
    keyId,
    privateKey: KEYS.actor,
    now: new Date(DATE),
  });
  return body === undefined ? { method, url, headers } : { method, url, headers, body };
}

const withHeader = (r: VectorRequest, name: string, value: string | null): VectorRequest => {
  const headers = { ...r.headers };
  if (value === null) delete headers[name];
  else headers[name] = value;
  return { ...r, headers };
};

export async function federationVectors() {
  const inboxUrl = `${channel}/inbox`;
  const inbound = await signed("POST", inboxUrl, `${remoteActor}#main-key`, follow);
  const shared = await signed("POST", "https://instance.example/ap/inbox", `${remoteActor}#main-key`, undo);
  const outbound = await signed("POST", `${remoteActor}/inbox`, `${channel}#main-key`, accept);
  const fetch = await signed("GET", remoteActor, `${channel}#main-key`);
  const v = { now: NOW, key: "actor" as const };
  const sigOf = (r: VectorRequest) => r.headers.signature as string;
  const later = (seconds: number) => new Date(Date.parse(NOW) + seconds * 1000).toISOString();

  const lines = (r: VectorRequest, covered: string[]) =>
    covered
      .map((h) =>
        h === "(request-target)"
          ? `(request-target): ${r.method.toLowerCase()} ${new URL(r.url).pathname}`
          : `${h}: ${r.headers[h]}`,
      )
      .join("\n");
  const full = ["(request-target)", "host", "date", "digest"];

  // A request signed over too few headers, built by hand (signRequest always covers digest).
  const { importPrivateKeyPem } = await import("./keys.ts");
  const { toBase64 } = await import("./digest.ts");
  const short = ["(request-target)", "host", "date"];
  const shortSig = toBase64(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "RSASSA-PKCS1-v1_5" },
        await importPrivateKeyPem(KEYS.actor),
        new TextEncoder().encode(lines(inbound, short)),
      ),
    ),
  );
  const noDigestCovered = withHeader(
    inbound,
    "signature",
    `keyId="${remoteActor}#main-key",algorithm="rsa-sha256",headers="${short.join(" ")}",signature="${shortSig}"`,
  );
  const evil = await signed("POST", inboxUrl, "https://evil.example/users/alice#main-key", follow);

  const vectors: Vector[] = [
    { name: "inbound follow", request: inbound, verify: v, expect: "ok", signingString: lines(inbound, full) },
    { name: "shared inbox undo", request: shared, verify: v, expect: "ok", signingString: lines(shared, full) },
    { name: "outbound accept", request: outbound, verify: v, expect: "ok", signingString: lines(outbound, full) },
    {
      name: "actor fetch without body",
      request: fetch,
      verify: { ...v, actorId: channel },
      expect: "ok",
      signingString: lines(fetch, short),
    },
    {
      name: "hs2019 algorithm name",
      request: withHeader(inbound, "signature", sigOf(inbound).replace('algorithm="rsa-sha256"', 'algorithm="hs2019"')),
      verify: v,
      expect: "ok",
    },
    {
      name: "within the skew window",
      request: inbound,
      verify: { ...v, now: later(43_200 - 60 - 1) },
      expect: "ok",
    },
    {
      name: "bad digest: body altered",
      request: { ...inbound, body: follow.replace("Follow", "Block") },
      verify: v,
      expect: "digest_mismatch",
    },
    {
      name: "altered header: digest replaced with another body's",
      request: { ...withHeader(inbound, "digest", shared.headers.digest as string), body: undo },
      verify: { ...v, actorId: remoteActor },
      expect: "bad_signature",
    },
    {
      name: "altered header: date",
      request: withHeader(inbound, "date", "Sun, 05 Jan 2025 21:31:41 GMT"),
      verify: v,
      expect: "bad_signature",
    },
    {
      name: "altered request target",
      request: { ...inbound, url: `${channel}/outbox` },
      verify: v,
      expect: "bad_signature",
    },
    {
      name: "host differs from the addressed host",
      request: { ...inbound, url: inboxUrl.replace("instance.example", "other.example") },
      verify: v,
      expect: "host_mismatch",
    },
    { name: "skewed date: too late", request: inbound, verify: { ...v, now: later(43_200 + 1) }, expect: "date_skew" },
    {
      name: "skewed date: too early",
      request: inbound,
      verify: { ...v, now: later(-43_200 - 120) },
      expect: "date_skew",
    },
    { name: "unparseable date", request: withHeader(inbound, "date", "yesterday"), verify: v, expect: "bad_date" },
    { name: "wrong keyId host", request: evil, verify: v, expect: "key_actor_mismatch" },
    { name: "wrong key", request: inbound, verify: { ...v, key: "other" }, expect: "bad_signature" },
    { name: "digest not covered", request: noDigestCovered, verify: v, expect: "missing_header" },
    {
      name: "covered header absent",
      request: withHeader(inbound, "digest", null),
      verify: v,
      expect: "missing_header",
    },
    {
      name: "unsupported algorithm",
      request: withHeader(
        inbound,
        "signature",
        sigOf(inbound).replace('algorithm="rsa-sha256"', 'algorithm="rsa-sha512"'),
      ),
      verify: v,
      expect: "unsupported_algorithm",
    },
    {
      name: "missing signature",
      request: withHeader(inbound, "signature", null),
      verify: v,
      expect: "missing_signature",
    },
    {
      name: "garbled signature header",
      request: withHeader(inbound, "signature", "keyId=unquoted"),
      verify: v,
      expect: "malformed_signature",
    },
  ];

  return {
    note: "Draft-cavage HTTP Signature vectors for packages/federation. Test keys (src/test-keys.json) only.",
    publicKeys: {
      actor: await publicKeyPemFromPrivate(KEYS.actor),
      other: await publicKeyPemFromPrivate(KEYS.other),
    },
    date: DATE,
    vectors,
  };
}

if (import.meta.main) process.stdout.write(`${JSON.stringify(await federationVectors(), null, 2)}\n`);
