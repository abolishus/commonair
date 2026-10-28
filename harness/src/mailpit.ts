// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Mailpit HTTP API client: find the mail the platform sent to a simulated user. */
import { waitFor } from "./wait.ts";

export interface MailSummary {
  id: string;
  subject: string;
  to: string[];
  created: string;
}

export interface MailMessage extends MailSummary {
  text: string;
  html: string;
}

interface SearchResponse {
  messages?: { ID: string; Subject: string; To?: { Address: string }[]; Created: string }[];
}
interface MessageResponse {
  ID: string;
  Subject: string;
  To?: { Address: string }[];
  /** The message endpoint has no `Created`; `Date` is the mail's Date header (whole seconds). */
  Date: string;
  Text?: string;
  HTML?: string;
}

/**
 * Mailpit with optional HTTP basic auth (Mailpit's `MP_UI_AUTH`, which also guards the API, when a
 * staging instance exposes it). Credentials come from `auth` (`user:password`) or from the URL's userinfo;
 * they are sent as a header, never left in the URL (fetch refuses URLs with credentials).
 */
export class Mailpit {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(baseUrl: string, auth?: string) {
    const { url, authorization } = mailpitEndpoint(baseUrl, auth);
    this.baseUrl = url;
    this.headers = authorization ? { authorization } : {};
  }

  private fetch(path: string, timeoutMs: number): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, { headers: this.headers, signal: AbortSignal.timeout(timeoutMs) });
  }

  async search(query: string): Promise<MailSummary[]> {
    const res = await this.fetch(`/api/v1/search?query=${encodeURIComponent(query)}&limit=50`, 5_000);
    if (!res.ok) throw new Error(`mailpit search failed: HTTP ${res.status}`);
    const body = (await res.json()) as SearchResponse;
    return (body.messages ?? []).map((m) => ({
      id: m.ID,
      subject: m.Subject,
      to: (m.To ?? []).map((t) => t.Address),
      created: m.Created,
    }));
  }

  async get(id: string): Promise<MailMessage> {
    const res = await this.fetch(`/api/v1/message/${encodeURIComponent(id)}`, 5_000);
    if (!res.ok) throw new Error(`mailpit message ${id} failed: HTTP ${res.status}`);
    const m = (await res.json()) as MessageResponse;
    return {
      id: m.ID,
      subject: m.Subject,
      to: (m.To ?? []).map((t) => t.Address),
      created: m.Date,
      text: m.Text ?? "",
      html: m.HTML ?? "",
    };
  }

  /** Wait for a message to `address` whose subject or body matches `match`. Newest first. */
  async waitForMessage(
    address: string,
    match: (m: MailMessage) => boolean = () => true,
    timeoutMs = 30_000,
  ): Promise<MailMessage> {
    return waitFor(
      `email to ${address.replace(/^(.).*@/, "$1…@")}`,
      async () => {
        for (const summary of await this.search(`to:"${address}"`)) {
          const message = await this.get(summary.id);
          if (match(message)) return message;
        }
        return null;
      },
      { timeoutMs, intervalMs: 500 },
    );
  }

  async ping(): Promise<boolean> {
    const res = await this.fetch("/api/v1/info", 3_000).catch(() => null);
    return res?.ok === true;
  }
}

/**
 * Base URL without credentials or trailing slash, plus the basic-auth header. An explicit `auth`
 * (`user:password`, split at the first colon like Mailpit does) wins over URL userinfo.
 */
export function mailpitEndpoint(baseUrl: string, auth?: string): { url: string; authorization: string | null } {
  const u = new URL(baseUrl);
  const fromUrl = u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` : null;
  u.username = "";
  u.password = "";
  const creds = auth || fromUrl;
  if (creds !== null && creds !== undefined && !creds.includes(":"))
    throw new Error("HARNESS_MAILPIT_AUTH must be user:password");
  return {
    url: u.toString().replace(/\/+$/, ""),
    authorization: creds ? `Basic ${Buffer.from(creds).toString("base64")}` : null,
  };
}

/** Every http(s) URL in a mail body, in order, with HTML entities in hrefs decoded. */
export function extractLinks(message: Pick<MailMessage, "text" | "html">): string[] {
  const found: string[] = [];
  const add = (u: string) => {
    const clean = u.replaceAll("&amp;", "&").replace(/[)>.,;'"]+$/, "");
    if (!found.includes(clean)) found.push(clean);
  };
  for (const m of message.html.matchAll(/href\s*=\s*"(https?:\/\/[^"]+)"/gi)) if (m[1]) add(m[1]);
  for (const m of message.text.matchAll(/https?:\/\/[^\s<>"']+/g)) add(m[0]);
  return found;
}

/** The verification / magic link in a mail: the first link carrying a token. */
export function findTokenLink(
  message: Pick<MailMessage, "text" | "html">,
  hint = /verify|token=|magic/i,
): string | null {
  return extractLinks(message).find((u) => hint.test(u)) ?? null;
}
