// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** A `watch_room` report's evidence in the mod queue (ADR 0017 decision 2): ids resolved to usernames. */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { parseRoomEvidence, WatchRoomEvidence } from "../src/components/safety/watch-room-evidence.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

const A = "01890000-0000-7000-8000-00000000a001";
const B = "01890000-0000-7000-8000-00000000a002";
const EVIDENCE = {
  v: 1,
  roomId: "01890000-0000-7000-8000-00000000f001",
  members: [
    { userId: A, host: true, joinedAt: "2026-11-01T10:00:00.000Z", leftAt: null },
    { userId: B, host: false, joinedAt: "2026-11-01T10:01:00.000Z", leftAt: "2026-11-01T10:05:00.000Z" },
  ],
  messages: [
    { id: "01890000-0000-7000-8000-00000000c001", userId: A, body: "hello", at: "2026-11-01T10:02:00.000Z" },
    {
      id: "01890000-0000-7000-8000-00000000c002",
      userId: B,
      body: "line one\nline two",
      at: "2026-11-01T10:03:00.000Z",
    },
  ],
  truncated: false,
};

const show = (evidence: Record<string, unknown>, lookup?: (ids: readonly string[]) => Promise<Map<string, string>>) =>
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <WatchRoomEvidence reportId="r1" evidence={evidence} {...(lookup ? { lookup } : {})} />
      </TooltipProvider>
    </LocaleProvider>,
  );

describe("WatchRoomEvidence", () => {
  it("lists members and messages with their ids and times; names come from the lookup", async () => {
    const asked: string[][] = [];
    show(EVIDENCE, async (ids) => {
      asked.push([...ids]);
      return new Map([[A, "alice"]]);
    });
    expect(screen.getByTestId("watch-room-evidence").dataset.reportId).toBe("r1");
    const members = screen.getAllByTestId("watch-room-evidence-member");
    expect(members.map((m) => [m.dataset.userId, m.dataset.joinedAt, m.dataset.leftAt])).toEqual([
      [A, "2026-11-01T10:00:00.000Z", ""],
      [B, "2026-11-01T10:01:00.000Z", "2026-11-01T10:05:00.000Z"],
    ]);
    const messages = screen.getAllByTestId("watch-room-evidence-message");
    expect(messages.map((m) => [m.dataset.userId, m.dataset.at])).toEqual([
      [A, "2026-11-01T10:02:00.000Z"],
      [B, "2026-11-01T10:03:00.000Z"],
    ]);
    await waitFor(() => expect(messages[0]!.textContent).toContain("alice"));
    expect(messages[1]!.textContent).toContain(t("watchRooms.evidence.unknownUser"));
    expect(asked).toEqual([[A, B]]);
    expect(members[0]!.textContent).toContain(t("watchRooms.evidence.stillIn"));
  });

  it("an empty transcript, a truncated one, and unreadable evidence", () => {
    show({ ...EVIDENCE, messages: [] });
    expect(screen.getByText(t("watchRooms.evidence.empty"))).toBeTruthy();
    cleanup();
    show({ ...EVIDENCE, truncated: true });
    expect(screen.getByText(t("watchRooms.evidence.truncated", { count: 2 }))).toBeTruthy();
    cleanup();
    show({ nonsense: true });
    expect(screen.getByTestId("watch-room-evidence").textContent).toBe(t("watchRooms.evidence.unreadable"));
  });

  it("parseRoomEvidence drops malformed rows", () => {
    const parsed = parseRoomEvidence({
      members: [{ userId: A, joinedAt: "x" }, { nope: 1 }, null],
      messages: [{ id: "m", userId: A, body: "b", at: "t" }, { id: 1 }],
    });
    expect(parsed).toEqual({
      members: [{ userId: A, host: false, joinedAt: "x", leftAt: null }],
      messages: [{ id: "m", userId: A, body: "b", at: "t" }],
      truncated: false,
      kept: 1,
    });
    expect(parseRoomEvidence({})).toBeNull();
  });
});
