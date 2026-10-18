// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Per-user cookie jar. Each simulated user talks to one API host, so the jar keys cookies by name
 * and path only; expiry and deletion (`Max-Age=0`, past `Expires`) are honoured so sign-out and
 * session rotation behave like a browser.
 */

interface StoredCookie {
  name: string;
  value: string;
  path: string;
  expiresAt: number | null;
}

export class CookieJar {
  private cookies = new Map<string, StoredCookie>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Store cookies from every `Set-Cookie` header of a response. */
  storeFrom(headers: Headers): void {
    for (const line of headers.getSetCookie()) this.store(line);
  }

  store(setCookie: string): void {
    const [pair = "", ...attrs] = setCookie.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    let path = "/";
    let expiresAt: number | null = null;
    for (const attr of attrs) {
      const [rawKey = "", ...rest] = attr.split("=");
      const key = rawKey.trim().toLowerCase();
      const v = rest.join("=").trim();
      if (key === "path" && v.startsWith("/")) path = v;
      else if (key === "max-age") {
        const seconds = Number(v);
        if (Number.isFinite(seconds)) expiresAt = this.now() + seconds * 1000;
      } else if (key === "expires" && expiresAt === null) {
        const t = Date.parse(v);
        if (Number.isFinite(t)) expiresAt = t;
      }
    }
    const key = `${path}\u0000${name}`;
    if (expiresAt !== null && expiresAt <= this.now()) {
      this.cookies.delete(key);
      return;
    }
    this.cookies.set(key, { name, value, path, expiresAt });
  }

  /** `Cookie` header value for a request path, or null when no cookie applies. */
  header(pathname = "/"): string | null {
    const now = this.now();
    const parts: string[] = [];
    // Longest path first, like browsers.
    const sorted = [...this.cookies.entries()].sort(([, a], [, b]) => b.path.length - a.path.length);
    for (const [key, c] of sorted) {
      if (c.expiresAt !== null && c.expiresAt <= now) {
        this.cookies.delete(key);
        continue;
      }
      if (pathname === c.path || pathname.startsWith(c.path.endsWith("/") ? c.path : `${c.path}/`) || c.path === "/") {
        parts.push(`${c.name}=${c.value}`);
      }
    }
    return parts.length > 0 ? parts.join("; ") : null;
  }

  get(name: string): string | undefined {
    for (const c of this.cookies.values()) if (c.name === name) return c.value;
    return undefined;
  }

  get size(): number {
    return this.cookies.size;
  }

  clear(): void {
    this.cookies.clear();
  }
}

export type FetchLike = (input: Request) => Promise<Response>;

/**
 * A fetch that sends and stores this jar's cookies and adds fixed headers (Origin for CSRF
 * checks, the harness's simulated client address for the forwarding proxy, a user agent).
 */
export function jarFetch(
  jar: CookieJar,
  extraHeaders: Record<string, string> = {},
  base: FetchLike = fetch,
): FetchLike {
  return async (request) => {
    const headers = new Headers(request.headers);
    for (const [k, v] of Object.entries(extraHeaders)) if (!headers.has(k)) headers.set(k, v);
    const cookie = jar.header(new URL(request.url).pathname);
    if (cookie) headers.set("cookie", cookie);
    const response = await base(new Request(request, { headers }));
    jar.storeFrom(response.headers);
    return response;
  };
}
