// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Image references (avatars, banners) must point at this instance: an object-storage key or a
 * URL on one of our own origins. A third-party URL would make every viewer's browser fetch from
 * someone else (tracking) and break the no-third-party-client-code rule.
 */
import type { Deps } from "../deps.ts";

const KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;

/** URL prefixes that count as "this instance" for media references. */
export function instanceMediaPrefixes(env: Deps["env"]): string[] {
  const s3 = (env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT).replace(/\/+$/, "");
  return [
    `${new URL(env.PUBLIC_URL).origin}/`,
    `${new URL(env.API_PUBLIC_URL).origin}/`,
    new URL(`${s3}/${env.S3_BUCKET_MEDIA}/`).href,
  ];
}

/**
 * True when `ref` is a storage key under `keyPrefix` (when given) or an http(s) URL starting with
 * one of `prefixes`. Keys may not climb (`..`) or contain empty segments.
 */
export function isInstanceMediaRef(ref: string, prefixes: readonly string[], keyPrefix?: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//")) {
    let url: URL;
    try {
      url = new URL(ref);
    } catch {
      return false;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.username || url.password) return false;
    return prefixes.some((p) => url.href.startsWith(p));
  }
  if (!KEY.test(ref)) return false;
  if (ref.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return false;
  return keyPrefix === undefined || ref.startsWith(keyPrefix);
}
