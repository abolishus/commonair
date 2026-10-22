// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** E6 page logic: simulcast, alert configs, the overlay token request, content rows, privacy rows. */
import { ALERT_TYPES } from "@commonair/contracts/enums";
import { describe, expect, it } from "vite-plus/test";
import { en } from "../src/i18n/en.ts";
import { clipRows, loadAllPages, visibilityOptions, vodRows, type ClipDto, type VodDto } from "../src/lib/content.ts";
import { isOverlayPath, overlayHead, overlayTokenFrom } from "../src/lib/overlay-page.ts";
import {
  ALERT_TYPE_ORDER,
  ALERT_VARIABLES,
  alertDraft,
  alertSetInput,
  orderedAlertConfigs,
  overlayTokenInput,
  type AlertConfigDto,
} from "../src/lib/overlays.ts";
import {
  deletionView,
  exportKindOptions,
  exportKinds,
  exportRows,
  shouldPollExports,
  withExport,
  type ExportJobDto,
} from "../src/lib/privacy.ts";
import {
  shouldPollSimulcast,
  simulcastError,
  simulcastPlatformOptions,
  simulcastRows,
  simulcastUrlProblem,
  type SimulcastTargetDto,
} from "../src/lib/simulcast.ts";
import { securityHeaders } from "../src/server/security.ts";

const NOW = Date.parse("2026-10-22T12:00:00.000Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const target = (over: Partial<SimulcastTargetDto> = {}): SimulcastTargetDto => ({
  id: "0192f000-0000-7000-8000-0000000000a1",
  platform: "custom",
  name: "Mock",
  rtmpUrl: "rtmp://mock-rtmp:1936/live",
  enabled: true,
  status: "idle",
  lastError: null,
  ...over,
});

describe("simulcast", () => {
  it("rows carry labels from the catalog and never a key", () => {
    const [row] = simulcastRows([target({ status: "live", platform: "youtube", lastError: "connect_refused" })]);
    expect(row).toEqual({
      id: "0192f000-0000-7000-8000-0000000000a1",
      name: "Mock",
      platform: "youtube",
      platformLabel: en["simulcast.platform.youtube"],
      rtmpUrl: "rtmp://mock-rtmp:1936/live",
      enabled: true,
      status: "live",
      statusLabel: en["simulcast.status.live"],
      lastError: "connect_refused",
    });
    expect(JSON.stringify(row)).not.toMatch(/key/i);
  });

  it("offers every platform", () => {
    expect(simulcastPlatformOptions().map((o) => o.value)).toEqual(["twitch", "youtube", "custom"]);
  });

  it("polls while a target is enabled or still winding down, not when nothing can change", () => {
    expect(shouldPollSimulcast([])).toBe(false);
    expect(shouldPollSimulcast([target({ enabled: false, status: "idle" })])).toBe(false);
    expect(shouldPollSimulcast([target({ enabled: false, status: "stopped" })])).toBe(false);
    expect(shouldPollSimulcast([target({ enabled: true, status: "idle" })])).toBe(true);
    expect(shouldPollSimulcast([target({ enabled: false, status: "live" })])).toBe(true);
    expect(shouldPollSimulcast([target({ enabled: false, status: "connecting" })])).toBe(true);
  });

  it.each([
    ["rtmp://mock-rtmp:1936/live", null],
    ["rtmps://live.example.org/app", null],
    ["  RTMP://Example.org/live  ", null],
    ["https://example.org/live", "format"],
    ["rtmp://", "format"],
    ["rtmp:///live", "format"],
    ["example.org/live", "format"],
    ["", "format"],
    ["rtmp://user:pass@example.org/live", "credentials"],
    ["rtmp://user@example.org/live", "credentials"],
  ])("URL %j: %s", (url, problem) => {
    expect(simulcastUrlProblem(url)).toBe(problem);
  });

  it("maps refusals to catalog text with a stable data-reason, never the server's message", () => {
    expect(simulcastError("format")).toEqual({ reason: "format", message: en["simulcast.error.format"] });
    expect(simulcastError("credentials").reason).toBe("credentials");
    expect(simulcastError({ code: "BAD_REQUEST", message: "Invalid RTMP URL" })).toEqual({
      reason: "url",
      message: en["simulcast.error.url"],
    });
    expect(
      simulcastError({ code: "PRECONDITION_FAILED", message: "x", data: { requirement: "simulcast_limit" } }),
    ).toEqual({ reason: "simulcast_limit", message: en["simulcast.error.limit"] });
    expect(simulcastError({ code: "UNAUTHORIZED" }).message).toBe(en["auth.sessionExpired"]);
    expect(simulcastError(new TypeError("fetch failed"))).toEqual({
      reason: "network",
      message: en["simulcast.error.generic"],
    });
    expect(simulcastError({ code: "INTERNAL_SERVER_ERROR", message: "select * from" }).message).toBe(
      en["simulcast.error.generic"],
    );
  });
});

const config = (type: AlertConfigDto["type"], over: Partial<AlertConfigDto> = {}): AlertConfigDto => ({
  type,
  enabled: false,
  template: { message: `\${user} ${type}`, animation: "fade", showMessage: true },
  minAmountCents: 0,
  durationMs: 6000,
  ...over,
});

describe("alert configs", () => {
  it("orders every ALERT_TYPES entry once, tip first, without inventing missing ones", () => {
    expect([...ALERT_TYPE_ORDER].sort()).toEqual([...ALERT_TYPES].sort());
    const shuffled = [config("raid"), config("follow"), config("tip"), config("subscription"), config("tip")];
    expect(orderedAlertConfigs(shuffled).map((c) => c.type)).toEqual(["tip", "follow", "subscription", "raid"]);
    expect(orderedAlertConfigs([config("follow")]).map((c) => c.type)).toEqual(["follow"]);
    for (const type of ALERT_TYPES) expect(ALERT_VARIABLES[type]).toContain("user");
    expect(ALERT_VARIABLES.tip).toContain("amount");
  });

  it("round-trips a config through the card's draft into alerts.set input", () => {
    const tip = config("tip", {
      enabled: true,
      minAmountCents: 100,
      durationMs: 5000,
      template: { message: "${user} tipped ${amount}", animation: "slide", showMessage: false },
    });
    const draft = alertDraft(tip);
    expect(draft).toEqual({
      enabled: true,
      message: "${user} tipped ${amount}",
      showMessage: false,
      minAmountCents: 100,
      durationMs: 5000,
      animation: "slide",
    });
    expect(alertSetInput("rivertide", "tip", draft)).toEqual({
      channel: "rivertide",
      type: "tip",
      enabled: true,
      template: { message: "${user} tipped ${amount}", animation: "slide", showMessage: false },
      minAmountCents: 100,
      durationMs: 5000,
    });
  });

  it("sends no media keys and no threshold outside tips", () => {
    const input = alertSetInput("rivertide", "follow", { ...alertDraft(config("follow")), minAmountCents: 500 });
    expect(input.minAmountCents).toBe(0);
    expect(Object.keys(input.template).sort()).toEqual(["animation", "message", "showMessage"]);
  });

  it("asks for a token with no expiry as null, else the exact instant", () => {
    expect(overlayTokenInput("rivertide", null)).toEqual({ channel: "rivertide", expiresAt: null });
    expect(overlayTokenInput("rivertide", "2026-10-29T12:00:00.000Z")).toEqual({
      channel: "rivertide",
      expiresAt: "2026-10-29T12:00:00.000Z",
    });
  });
});

const vod = (over: Partial<VodDto> = {}): VodDto => ({
  id: "v1",
  channelSlug: "rivertide",
  title: "Glaze night",
  status: "ready",
  visibility: "public",
  durationSeconds: 40,
  thumbnailUrl: null,
  playlistUrl: null,
  createdAt: iso(NOW - HOUR),
  expiresAt: null,
  failedReason: null,
  ...over,
});
const clip = (over: Partial<ClipDto> = {}): ClipDto => ({
  id: "c1",
  channelSlug: "rivertide",
  title: "Handle",
  creator: { id: "u2", username: "viewer", displayName: "Viewer" },
  status: "ready",
  durationSeconds: 10,
  url: null,
  thumbnailUrl: null,
  views: 1234,
  createdAt: iso(NOW - HOUR),
  ...over,
});

describe("content", () => {
  it("rows leave deleted media out and carry status labels", () => {
    const rows = vodRows([vod(), vod({ id: "v2", status: "deleted" }), vod({ id: "v3", visibility: "private" })]);
    expect(rows.map((r) => [r.id, r.visibility, r.statusLabel])).toEqual([
      ["v1", "public", en["content.status.ready"]],
      ["v3", "private", en["content.status.ready"]],
    ]);
    const clipsOut = clipRows([clip(), clip({ id: "c2", status: "deleted" }), clip({ id: "c3", creator: null })], (n) =>
      String(n),
    );
    expect(clipsOut.map((c) => [c.id, c.creatorName, c.viewsLabel])).toEqual([
      ["c1", "Viewer", "1234"],
      ["c3", null, "1234"],
    ]);
  });

  it("offers every visibility", () => {
    expect(visibilityOptions().map((o) => o.value)).toEqual(["public", "subscribers", "private"]);
  });

  it("loads every page until the cursor ends, and stops at the page cap", async () => {
    const pages: Record<string, { items: number[]; nextCursor: string | null }> = {
      first: { items: [1, 2], nextCursor: "b" },
      b: { items: [3], nextCursor: "c" },
      c: { items: [4], nextCursor: null },
    };
    const seen: (string | undefined)[] = [];
    const all = await loadAllPages(async (cursor) => {
      seen.push(cursor);
      return pages[cursor ?? "first"] ?? { items: [], nextCursor: null };
    });
    expect(all).toEqual([1, 2, 3, 4]);
    expect(seen).toEqual([undefined, "b", "c"]);
    let calls = 0;
    const capped = await loadAllPages(async () => {
      calls++;
      return { items: [calls], nextCursor: "more" };
    }, 3);
    expect(capped).toEqual([1, 2, 3]);
  });
});

const job = (over: Partial<ExportJobDto> = {}): ExportJobDto => ({
  id: "e1",
  kind: "account",
  status: "ready",
  downloadUrl: "https://s3.example/exports/u/e1.zip?X-Amz-Signature=abc",
  sizeBytes: 2048,
  expiresAt: iso(NOW + 7 * 24 * HOUR),
  createdAt: iso(NOW - HOUR),
  completedAt: iso(NOW - HOUR),
  ...over,
});

describe("privacy", () => {
  it("offers the channel export only to channel owners", () => {
    expect(exportKinds(false)).toEqual(["account"]);
    expect(exportKinds(true)).toEqual(["account", "channel"]);
  });

  it("disables a kind for 24 h after a queued, running or ready export of it", () => {
    const options = exportKindOptions(["account", "channel"], [job({ status: "running", downloadUrl: null })], NOW);
    expect(options.map((o) => [o.kind, o.cooldownUntil])).toEqual([
      ["account", iso(NOW - HOUR + 24 * HOUR)],
      ["channel", null],
    ]);
    expect(exportKindOptions(["account"], [job({ status: "failed" })], NOW)[0]?.cooldownUntil).toBeNull();
    expect(exportKindOptions(["account"], null, NOW)[0]?.cooldownUntil).toBeNull();
  });

  it("rows are newest first and offer a link only while ready and unexpired", () => {
    const rows = exportRows(
      [
        job({ id: "old", createdAt: iso(NOW - 48 * HOUR), expiresAt: iso(NOW - HOUR) }),
        job({ id: "new" }),
        job({ id: "run", status: "running", createdAt: iso(NOW - 2 * HOUR), downloadUrl: null, expiresAt: null }),
      ],
      NOW,
    );
    expect(rows.map((r) => [r.id, r.downloadUrl !== null, r.statusLabel])).toEqual([
      ["new", true, en["privacy.export.status.ready"]],
      ["run", false, en["privacy.export.status.running"]],
      ["old", false, en["privacy.export.status.ready"]],
    ]);
    expect(exportRows([job({ status: "expired" })], NOW)[0]?.downloadUrl).toBeNull();
  });

  it("polls only while an export is queued or running", () => {
    expect(shouldPollExports([])).toBe(false);
    expect(shouldPollExports([job(), job({ status: "failed" }), job({ status: "expired" })])).toBe(false);
    expect(shouldPollExports([job({ status: "queued" })])).toBe(true);
    expect(shouldPollExports([job({ status: "running" })])).toBe(true);
  });

  it("puts a new export first, replacing a stale copy", () => {
    expect(withExport(null, job({ id: "x" })).map((j) => j.id)).toEqual(["x"]);
    expect(
      withExport([job({ id: "a" }), job({ id: "x", status: "queued" })], job({ id: "x" })).map((j) => j.id),
    ).toEqual(["x", "a"]);
  });

  it("shows the deletion request with its label", () => {
    expect(deletionView(null)).toBeNull();
    expect(
      deletionView({ id: "d", status: "scheduled", scheduledFor: iso(NOW + 30 * 24 * HOUR), retained: [] }),
    ).toEqual({
      status: "scheduled",
      statusLabel: en["privacy.deletion.status.scheduled"],
      scheduledFor: iso(NOW + 30 * 24 * HOUR),
    });
  });
});

describe("overlay pages", () => {
  it("recognizes /overlay/* only", () => {
    expect(isOverlayPath("/overlay/alerts")).toBe(true);
    expect(isOverlayPath("/overlay/goals")).toBe(true);
    expect(isOverlayPath("/overlays")).toBe(false);
    expect(isOverlayPath("/overlay")).toBe(false);
  });

  it("reads the token from the query, nothing else", () => {
    expect(overlayTokenFrom("?token=abc")).toBe("abc");
    expect(overlayTokenFrom("?x=1&token=a%2Bb")).toBe("a+b");
    expect(overlayTokenFrom("")).toBeNull();
    expect(overlayTokenFrom("?token=")).toBeNull();
    expect(overlayTokenFrom("?token=%20")).toBeNull();
  });

  it("sends no referrer, from the page head and the server's header", () => {
    const head = overlayHead("Alerts overlay");
    expect(head.meta).toContainEqual({ name: "referrer", content: "no-referrer" });
    expect(head.meta).toContainEqual({ name: "color-scheme", content: "normal" });
    expect(securityHeaders("/overlay/alerts")["referrer-policy"]).toBe("no-referrer");
    expect(securityHeaders("/overlay/alerts")["content-security-policy"]).toBe("frame-ancestors 'self'");
    expect(securityHeaders("/overlays")["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });
});
