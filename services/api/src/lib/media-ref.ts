// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Image references (avatars, banners) must point at this instance's media bucket: an object
 * key, or the bucket's public URL for that key. A third-party URL would make every viewer's
 * browser fetch from someone else (tracking) and break the no-third-party-client-code rule.
 */
import type { Deps } from "../deps.ts";

const KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;

/** The public URL prefix of media objects (`MEDIA_PUBLIC_URL` + `/`), normalized. */
export function instanceMediaBase(env: Pick<Deps["env"], "MEDIA_PUBLIC_URL">): string {
  return new URL(`${env.MEDIA_PUBLIC_URL.replace(/\/+$/, "")}/`).href;
}

function isKey(key: string, keyPrefix: string | undefined): boolean {
  if (!KEY.test(key)) return false;
  if (key.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return false;
  return keyPrefix === undefined || key.startsWith(keyPrefix);
}

/**
 * True when `ref` is a storage key under `keyPrefix` (when given), or an http(s) URL inside the
 * media bucket whose key satisfies the same rule. Keys may not climb (`..`) or have empty segments.
 */
export function isInstanceMediaRef(ref: string, mediaBase: string, keyPrefix?: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//")) {
    let url: URL;
    try {
      url = new URL(ref);
    } catch {
      return false;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.username || url.password || url.search || url.hash) return false;
    if (!url.href.startsWith(mediaBase)) return false;
    let key: string;
    try {
      key = decodeURIComponent(url.href.slice(mediaBase.length));
    } catch {
      return false;
    }
    return isKey(key, keyPrefix);
  }
  return isKey(ref, keyPrefix);
}
