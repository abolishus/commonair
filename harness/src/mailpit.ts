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
  Created: string;
  Text?: string;
  HTML?: string;
}

export class Mailpit {
  constructor(private readonly baseUrl: string) {}

  async search(query: string): Promise<MailSummary[]> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/api/v1/search?query=${encodeURIComponent(query)}&limit=50`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
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
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/api/v1/message/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`mailpit message ${id} failed: HTTP ${res.status}`);
    const m = (await res.json()) as MessageResponse;
    return {
      id: m.ID,
      subject: m.Subject,
      to: (m.To ?? []).map((t) => t.Address),
      created: m.Created,
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
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/api/v1/info`, {
      signal: AbortSignal.timeout(3_000),
    }).catch(() => null);
    return res?.ok === true;
  }
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
