// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Outbound federation requests (ADR 0030 decisions 4, 5 and 8). Every URL here was chosen by a
 * stranger (a `keyId`, an actor id, an inbox), so each goes through `resolveCallback`: https only
 * and a pinned public address unless `OUTBOUND_ALLOW_PRIVATE_NETWORKS` (harness), no redirects,
 * a response cap and a deadline. POSTs use the webhooks' `postPinned`; GETs are here.
 */
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { ACTIVITY_CONTENT_TYPE, signRequest } from "@commonair/federation";
import { postPinned, type PostResult } from "../webhooks/http.ts";
import { CallbackRejected, resolveCallback } from "../webhooks/ssrf.ts";
import { FEDERATION_USER_AGENT, type FederationConfig } from "./config.ts";

/** What Mastodon and the AP spec accept for actor and key documents. */
const ACCEPT = `${ACTIVITY_CONTENT_TYPE}, application/ld+json; profile="https://www.w3.org/ns/activitystreams"`;

export type FetchResult =
  | { ok: true; status: number; json: unknown }
  /** `rejected`: the guard refused the URL; `gone`: 404 or 410; `failed`: anything else. */
  | { ok: false; reason: "rejected" | "gone" | "failed"; status?: number };

type GetConfig = Pick<FederationConfig, "allowInsecure" | "timeoutMs" | "maxResponseBytes" | "resolve" | "ca">;

/** GET an ActivityPub document (unsigned) through the SSRF guard and parse it as JSON. */
export async function fetchActivityJson(raw: string, cfg: GetConfig): Promise<FetchResult> {
  let target;
  try {
    target = await resolveCallback(raw, cfg);
  } catch (err) {
    if (err instanceof CallbackRejected) return { ok: false, reason: "rejected" };
    throw err;
  }
  const { url, hostname, address } = target;
  const lookup: LookupFunction = (_host, options, cb) => {
    if (options && options.all) cb(null, [{ address: address.address, family: address.family }]);
    else cb(null, address.address, address.family);
  };
  const mod = url.protocol === "https:" ? https : http;
  const res = await new Promise<{ status: number; body: string } | null>((resolve) => {
    let settled = false;
    const finish = (r: { status: number; body: string } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(r);
    };
    const req = mod.request(
      {
        method: "GET",
        protocol: url.protocol,
        host: hostname,
        servername: hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        // The fragment (`#main-key`) is never sent.
        path: `${url.pathname}${url.search}`,
        lookup,
        agent: false,
        ...(cfg.ca ? { ca: cfg.ca } : {}),
        headers: { accept: ACCEPT, "user-agent": FEDERATION_USER_AGENT },
      },
      (r) => {
        const chunks: Buffer[] = [];
        let size = 0;
        r.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > cfg.maxResponseBytes) {
            r.destroy();
            finish(null);
            return;
          }
          chunks.push(chunk);
        });
        r.on("end", () => finish({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        r.on("error", () => finish(null));
      },
    );
    const deadline = setTimeout(() => {
      req.destroy(new Error("timeout"));
      finish(null);
    }, cfg.timeoutMs);
    req.on("error", () => finish(null));
    req.end();
  });
  if (!res) return { ok: false, reason: "failed" };
  if (res.status === 404 || res.status === 410) return { ok: false, reason: "gone", status: res.status };
  if (res.status < 200 || res.status >= 300) return { ok: false, reason: "failed", status: res.status };
  try {
    return { ok: true, status: res.status, json: JSON.parse(res.body) };
  } catch {
    return { ok: false, reason: "failed", status: res.status };
  }
}

/**
 * Sign an activity with the channel actor's key and POST it to one inbox. The key is a CryptoKey
 * imported at use from the decrypted PEM; neither is logged.
 */
export async function postActivity(
  inbox: string,
  activity: Record<string, unknown>,
  signer: { keyId: string; privateKey: CryptoKey },
  cfg: Pick<FederationConfig, "allowInsecure" | "timeoutMs" | "maxResponseBytes" | "resolve" | "ca">,
  now: Date,
): Promise<PostResult> {
  const body = JSON.stringify(activity);
  const signed = await signRequest({
    method: "POST",
    url: inbox,
    body,
    keyId: signer.keyId,
    privateKey: signer.privateKey,
    now,
  });
  // postPinned sets content-type, content-length and user-agent; host comes from the URL.
  const { host: _host, ...headers } = signed;
  return postPinned(
    inbox,
    { headers, body, contentType: ACTIVITY_CONTENT_TYPE, userAgent: FEDERATION_USER_AGENT },
    {
      allowInsecure: cfg.allowInsecure,
      timeoutMs: cfg.timeoutMs,
      maxResponseBytes: Math.min(cfg.maxResponseBytes, 16 * 1024),
      ...(cfg.resolve ? { resolve: cfg.resolve } : {}),
      ...(cfg.ca ? { ca: cfg.ca } : {}),
    },
  );
}
