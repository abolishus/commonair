// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Fetch one emote image from Twitch's CDN for the import (ADR 0031 decision 5): only from a host in
 * `TWITCH_IMAGE_HOSTS`, through the SSRF guard (`resolveCallback`: https, public addresses, the
 * address pinned; with `allowInsecure` from `OUTBOUND_ALLOW_PRIVATE_NETWORKS`, http and private
 * addresses for the harness mock), no redirects, a size cap and a deadline. node:http(s) with a
 * pinned `lookup`, as the webhook sender does, so DNS cannot be rebound between check and connect.
 *
 * A refusal is a result, never an exception: the import reports the emote without its image.
 */
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { CallbackRejected, resolveCallback, type Resolver } from "../webhooks/ssrf.ts";

export interface FetchImageOptions {
  /** `TWITCH_IMAGE_HOSTS`: exact host names (no ports, no wildcards). */
  allowedHosts: readonly string[];
  /** `OUTBOUND_ALLOW_PRIVATE_NETWORKS`. */
  allowInsecure: boolean;
  maxBytes: number;
  timeoutMs?: number;
  resolve?: Resolver;
}

export type FetchImageResult =
  | { ok: true; bytes: Uint8Array; contentType: string | null }
  | { ok: false; reason: "host_not_allowed" | "rejected_address" | "http_error" | "too_large" | "network" };

export const IMAGE_TIMEOUT_MS = 15_000;

/** Is `raw` on one of the allowed hosts? Exact, case-insensitive host name match. */
export function onAllowedHost(raw: string, allowedHosts: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return allowedHosts.some((h) => h.trim().toLowerCase().replace(/\.$/, "") === host && host !== "");
}

export async function fetchTwitchImage(raw: string, opts: FetchImageOptions): Promise<FetchImageResult> {
  if (!onAllowedHost(raw, opts.allowedHosts)) return { ok: false, reason: "host_not_allowed" };
  let target;
  try {
    target = await resolveCallback(raw, {
      allowInsecure: opts.allowInsecure,
      ...(opts.resolve ? { resolve: opts.resolve } : {}),
    });
  } catch (err) {
    return { ok: false, reason: err instanceof CallbackRejected ? "rejected_address" : "network" };
  }
  const { url, hostname, address } = target;
  const pinned: LookupFunction = (_host, options, cb) => {
    if (options && options.all) cb(null, [{ address: address.address, family: address.family }]);
    else cb(null, address.address, address.family);
  };
  const mod = url.protocol === "https:" ? https : http;
  return new Promise<FetchImageResult>((resolve) => {
    let settled = false;
    const finish = (r: FetchImageResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(r);
    };
    const request = mod.request(
      {
        method: "GET",
        protocol: url.protocol,
        host: hostname,
        servername: hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        lookup: pinned,
        agent: false,
        headers: { accept: "image/png,image/gif,image/webp", "user-agent": "CommonAir-Import/1" },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // Redirects are never followed (node:http does not), and anything but 200 is refused.
        if (status !== 200) {
          res.resume();
          finish({ ok: false, reason: "http_error" });
          return;
        }
        const declared = Number(res.headers["content-length"] ?? "");
        if (Number.isFinite(declared) && declared > opts.maxBytes) {
          res.destroy();
          finish({ ok: false, reason: "too_large" });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > opts.maxBytes) {
            res.destroy();
            finish({ ok: false, reason: "too_large" });
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          finish({
            ok: true,
            bytes: new Uint8Array(Buffer.concat(chunks)),
            contentType: typeof res.headers["content-type"] === "string" ? res.headers["content-type"] : null,
          }),
        );
        res.on("error", () => finish({ ok: false, reason: "network" }));
      },
    );
    const deadline = setTimeout(() => {
      request.destroy(new Error("timeout"));
      finish({ ok: false, reason: "network" });
    }, opts.timeoutMs ?? IMAGE_TIMEOUT_MS);
    request.on("error", () => finish({ ok: false, reason: "network" }));
    request.end();
  });
}
