// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vite-plus/test";
import { en } from "../src/i18n/en.ts";
import {
  RELAY_HOST_PLACEHOLDER,
  RELAY_STATUSES,
  RELAY_STATUS_BADGES,
  formatBytes,
  relayName,
  relayReadmeUrl,
  relayRunCommand,
  relayStatusView,
} from "../src/lib/relays.ts";

describe("relay status badges", () => {
  it("covers exactly the contract's statuses", () => {
    expect(Object.keys(RELAY_STATUS_BADGES).sort()).toEqual([...RELAY_STATUSES].sort());
  });

  it.each(RELAY_STATUSES)("%s has catalog strings", (status) => {
    const badge = RELAY_STATUS_BADGES[status];
    expect(badge.key in en).toBe(true);
    expect(badge.hintKey in en).toBe(true);
    const view = relayStatusView(status);
    expect(view.label).toBe(en[badge.key]);
    expect(view.hint).toBe(en[badge.hintKey]);
  });

  // The badge moved from `Badge` variants to `StatusBadge` tones (E4a); the rule is the same.
  it("marks suspension as danger and active as the success badge", () => {
    expect(relayStatusView("suspended").tone).toBe("danger");
    expect(relayStatusView("active").tone).toBe("success");
    for (const s of RELAY_STATUSES.filter((x) => x !== "suspended")) expect(relayStatusView(s).tone).not.toBe("danger");
    for (const s of RELAY_STATUSES.filter((x) => x !== "active")) expect(relayStatusView(s).tone).not.toBe("success");
  });

  it("gives every status a distinct label", () => {
    const labels = RELAY_STATUSES.map((s) => relayStatusView(s).label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("formatBytes", () => {
  const f = (n: number) => formatBytes(n, "en");

  it("prints whole bytes below 1 kB", () => {
    expect(f(0)).toBe("0 byte");
    expect(f(1)).toBe("1 byte");
    expect(f(999)).toBe("999 byte");
  });

  it("uses SI units with one fraction digit", () => {
    expect(f(1000)).toBe("1.0 kB");
    expect(f(1500)).toBe("1.5 kB");
    expect(f(2_500_000)).toBe("2.5 MB");
    expect(f(3_210_000_000)).toBe("3.2 GB");
    expect(f(7e12)).toBe("7.0 TB");
  });

  it("carries a value that would round up to 1000 into the next unit", () => {
    expect(f(999_950)).toBe("1.0 MB");
    expect(f(999_949)).toBe("999.9 kB");
  });

  it("stops at petabytes", () => {
    expect(f(5e18)).toBe("5,000.0 PB");
  });

  it("treats negative and non-finite input as zero", () => {
    expect(f(-5)).toBe("0 byte");
    expect(f(Number.NaN)).toBe("0 byte");
    expect(f(Number.POSITIVE_INFINITY)).toBe("0 byte");
  });

  it("follows the locale", () => {
    expect(formatBytes(1500, "de")).toBe("1,5 kB");
  });
});

describe("relayRunCommand", () => {
  it("is the contract's command with the instance URL and token", () => {
    expect(relayRunCommand("https://air.example", "relay_abc")).toBe(
      "commonair-relay --api https://air.example --token relay_abc --public-url https://<your-host>",
    );
  });

  it("drops trailing slashes from the instance URL", () => {
    expect(relayRunCommand("http://localhost:3100//", "relay_x")).toBe(
      `commonair-relay --api http://localhost:3100 --token relay_x --public-url ${RELAY_HOST_PLACEHOLDER}`,
    );
  });

  it("keeps the host a placeholder", () => {
    expect(relayRunCommand("https://a.example", "t")).toContain("--public-url https://<your-host>");
  });
});

describe("relayReadmeUrl", () => {
  it("links the README at the commit the instance runs", () => {
    expect(relayReadmeUrl("https://git.example/o/r/tree/abc123")).toBe(
      "https://git.example/o/r/blob/abc123/relay/README.md",
    );
  });

  it("links the default branch when no commit is known", () => {
    expect(relayReadmeUrl("https://git.example/o/r/")).toBe("https://git.example/o/r/blob/HEAD/relay/README.md");
  });

  it("is null without a source URL", () => {
    expect(relayReadmeUrl(null)).toBeNull();
    expect(relayReadmeUrl("")).toBeNull();
  });
});

describe("relayName", () => {
  it("trims and accepts 1 to 50 characters", () => {
    expect(relayName("  home relay ")).toBe("home relay");
    expect(relayName("a")).toBe("a");
    expect(relayName("x".repeat(50))).toBe("x".repeat(50));
  });

  it("refuses empty and over-long names", () => {
    expect(relayName("")).toBeNull();
    expect(relayName("   ")).toBeNull();
    expect(relayName("x".repeat(51))).toBeNull();
  });
});
