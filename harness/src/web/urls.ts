// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Pure URL helpers for driving the web app like a person with OBS and a mail client would. */

/**
 * The publish URL OBS builds from the dashboard's "Server" and "Stream key" fields:
 * `<server>/<key>`, with exactly one slash between them.
 */
export function obsPublishUrl(server: string, key: string): string {
  const s = server.trim().replace(/\/+$/, "");
  const k = key.trim().replace(/^\/+/, "");
  if (!/^rtmps?:\/\//.test(s)) throw new Error(`stream server URL must be rtmp:// or rtmps:// (got "${s}")`);
  if (k.length === 0) throw new Error("stream key is empty");
  return `${s}/${k}`;
}

/**
 * Replace the scheme, host and port of `url` with those of `base`, keeping path and query. Used
 * when the public ingest URL the dashboard shows is not reachable from the harness host.
 */
export function rebaseOrigin(url: string, base: string): string {
  // URL cannot set the host of non-special schemes (rtmp:), so split by hand.
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)(.*)$/i.exec(url);
  const b = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)/i.exec(base);
  if (!m || !b) throw new Error(`cannot rebase ${url} onto ${base}`);
  return `${b[1]}${m[2] ?? ""}`;
}

/**
 * The verification link as a browser should open it. The email carries `PUBLIC_URL` +
 * `/api/auth/verify-email…`, which the web app proxies. When the harness reaches the web app at
 * another origin than the public one (e.g. a container name vs localhost), rebase API and RPC
 * paths onto the web URL so the session cookie lands on the origin the browser is using.
 */
export function browserVerificationUrl(link: string, webUrl: string): string {
  const u = new URL(link);
  const web = new URL(webUrl);
  if (u.origin === web.origin) return u.toString();
  if (!u.pathname.startsWith("/api/") && !u.pathname.startsWith("/rpc/")) return u.toString();
  return new URL(`${u.pathname}${u.search}${u.hash}`, web.origin).toString();
}
