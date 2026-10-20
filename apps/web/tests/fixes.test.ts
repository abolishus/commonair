// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { NOTICE_CODES } from "@commonair/contracts/chat";
import { isRedirect } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";
import { errorMessage, noticeMessage } from "../src/chat/messages.ts";
import { t } from "../src/i18n/index.ts";
import { requireSession } from "../src/lib/guard.ts";
import { safeHttpUrl } from "../src/lib/url.ts";
import { pageLifecycle } from "../src/player/lifecycle.ts";

describe("chat messages", () => {
  it("translates every notice code the contract defines", () => {
    const generic = t("chat.notice.generic");
    for (const code of NOTICE_CODES) expect(noticeMessage(code), code).not.toBe(generic);
  });

  it("falls back to generic messages for unknown codes", () => {
    expect(noticeMessage("brand_new_code")).toBe(t("chat.notice.generic"));
    expect(errorMessage("UNAUTHORIZED")).toBe(t("chat.error.generic"));
    expect(errorMessage("rate_limited")).toBe(t("chat.error.rateLimited"));
    expect(errorMessage("channel_not_found")).toBe(t("chat.error.channelNotFound"));
  });

  it("never shows server-provided text", () => {
    expect(noticeMessage("msg_slowmode")).toBe(t("chat.notice.slowMode"));
  });
});

describe("requireSession", () => {
  it("redirects to /signin without a session", async () => {
    const err = await requireSession(async () => null).catch((e: unknown) => e);
    expect(isRedirect(err)).toBe(true);
    expect((err as { options: { to: string } }).options.to).toBe("/signin");
  });

  it("passes the session through", async () => {
    const me = { id: "u1", username: "alice_1", displayName: "Alice", channelSlug: "alice_1", role: "user" as const };
    expect(await requireSession(async () => me)).toEqual({ me });
  });
});

describe("pageLifecycle", () => {
  function setup() {
    const calls: string[] = [];
    return {
      calls,
      l: pageLifecycle(
        () => calls.push("stop"),
        () => calls.push("restart"),
      ),
    };
  }

  it("ends the session when the page really unloads", () => {
    const s = setup();
    s.l.pagehide({ persisted: false });
    expect(s.calls).toEqual(["stop"]);
  });

  it("keeps it into the back/forward cache and restarts on restore", () => {
    const s = setup();
    s.l.pagehide({ persisted: true });
    expect(s.calls).toEqual([]);
    s.l.pageshow({ persisted: true });
    expect(s.calls).toEqual(["restart"]);
  });

  it("does nothing on a normal first show", () => {
    const s = setup();
    s.l.pageshow({ persisted: false });
    expect(s.calls).toEqual([]);
  });
});

describe("safeHttpUrl", () => {
  it("accepts absolute http(s) URLs only", () => {
    expect(safeHttpUrl("https://example.org/src/tree/abc")).toBe("https://example.org/src/tree/abc");
    expect(safeHttpUrl("HTTP://example.org")).toBe("HTTP://example.org");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,x")).toBeNull();
    expect(safeHttpUrl("//example.org")).toBeNull();
    expect(safeHttpUrl("https://")).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
});
