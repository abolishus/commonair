// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * IRCv3 capability negotiation, Twitch flavour.
 *
 * Twitch never makes clients wait for `CAP END` unless they started with `CAP LS`
 * (tmi.js sends `CAP REQ` then `PASS`/`NICK` and expects to be registered), so
 * registration is suspended only between `CAP LS` and `CAP END`. `CAP REQ` is
 * atomic as IRCv3 requires: if any requested cap is unsupported the whole
 * request is NAKed and nothing changes.
 */

export const SUPPORTED_CAPS = ["twitch.tv/tags", "twitch.tv/commands", "twitch.tv/membership"] as const;
export type Cap = (typeof SUPPORTED_CAPS)[number];

const isCap = (s: string): s is Cap => (SUPPORTED_CAPS as readonly string[]).includes(s);

export interface CapReply {
  subcommand: "LS" | "LIST" | "ACK" | "NAK";
  caps: string;
}

export type CapResult =
  | { kind: "reply"; reply: CapReply }
  | { kind: "end" }
  | { kind: "invalid"; subcommand: string }
  | { kind: "none" };

export class CapNegotiator {
  readonly enabled = new Set<Cap>();
  /** True between `CAP LS` and `CAP END` while unregistered. */
  suspended = false;

  has(cap: Cap): boolean {
    return this.enabled.has(cap);
  }

  /** Handle `CAP <sub> [args]`; `registered` tells whether registration already completed. */
  handle(subcommand: string, args: string[], registered: boolean): CapResult {
    switch (subcommand.toUpperCase()) {
      case "LS":
        if (!registered) this.suspended = true;
        return { kind: "reply", reply: { subcommand: "LS", caps: SUPPORTED_CAPS.join(" ") } };
      case "LIST":
        return { kind: "reply", reply: { subcommand: "LIST", caps: [...this.enabled].join(" ") } };
      case "REQ":
        return { kind: "reply", reply: this.request(args.join(" ")) };
      case "END": {
        const wasSuspended = this.suspended;
        this.suspended = false;
        return wasSuspended ? { kind: "end" } : { kind: "none" };
      }
      default:
        return { kind: "invalid", subcommand };
    }
  }

  private request(raw: string): CapReply {
    const items = raw.split(" ").filter(Boolean);
    const parsed = items.map((item) => ({ remove: item.startsWith("-"), name: item.replace(/^-/, "") }));
    if (parsed.length === 0 || parsed.some((p) => !isCap(p.name))) return { subcommand: "NAK", caps: raw.trim() };
    for (const p of parsed) {
      if (!isCap(p.name)) continue;
      if (p.remove) this.enabled.delete(p.name);
      else this.enabled.add(p.name);
    }
    return { subcommand: "ACK", caps: raw.trim() };
  }
}
