// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where the email-verification link lands (design overhaul F11). better-auth puts the sign-up's
 * `callbackURL` on the link as given; we keep it only when it is a path on this instance and
 * otherwise send the new member to the front page, never a fixed studio page.
 */

/** A relative path with one leading slash, no backslash or whitespace (as `ReturnPath`). */
const RELATIVE_PATH = /^\/(?!\/)[^\s\\]*$/;
const MAX_LENGTH = 4096;

/**
 * The callback as a same-origin path: a relative path is kept, an absolute URL on `publicUrl`'s
 * origin becomes its path, anything else (missing, another origin, a scheme-relative or malformed
 * value) is "/".
 */
export function verificationCallbackPath(raw: string | null | undefined, publicUrl: string): string {
  if (!raw || raw.length > MAX_LENGTH) return "/";
  if (raw.startsWith("/")) return RELATIVE_PATH.test(raw) ? raw : "/";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "/";
  }
  if (parsed.origin !== new URL(publicUrl).origin) return "/";
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return RELATIVE_PATH.test(path) ? path : "/";
}

/** The verification link with its `callbackURL` replaced by `verificationCallbackPath`. */
export function withVerificationCallback(link: string, publicUrl: string): string {
  const url = new URL(link);
  url.searchParams.set("callbackURL", verificationCallbackPath(url.searchParams.get("callbackURL"), publicUrl));
  return url.toString();
}
