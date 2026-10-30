// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Calm Chat under the `e2e-social` flood (harness/src/w1/calm.ts `floodPlan`): 50 messages a
 * second for 10 s from 30 senders, three waves of repeated bodies, six mentions of the viewer, the
 * log capped at `MAX_MESSAGES`. Records when each row id first appears in `useCalm`'s view (as the
 * harness's MutationObserver does in the page) and checks at most 3 new non-mention rows in any
 * one-second window, with no render latency to hide behind.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useCalm } from "../src/chat/calm/use-calm.ts";
import { MAX_MESSAGES, type ChatMessageFrame } from "../src/chat/connection.ts";
import type { ChatRow } from "../src/chat/state.ts";

const UUID = (n: number) => `0195f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);
const SELF = "fan";

function msg(n: number, body: string, user: number, at: number): ChatMessageFrame {
  return {
    id: UUID(n),
    channelId: UUID(9999),
    user: {
      id: UUID(5000 + user),
      username: `bot${user}`,
      displayName: `Bot ${user}`,
      color: null,
      badges: [],
      accountType: "human",
    },
    body,
    emotes: [],
    isAction: false,
    replyTo: null,
    createdAt: new Date(T0 + at).toISOString(),
  };
}

/** The harness's flood: bot turns 1, 6 and 11 send the repeated bodies; six mentions spread out. */
function floodLines(start: number) {
  const repeated = ["PogChamp", "LUL what a play", "KEKW"];
  const lines: { message: ChatMessageFrame; mention: boolean }[] = [];
  let mentions = 0;
  for (let i = 0; i < 500; i++) {
    const turn = Math.floor(i / 30);
    const at = start + i * 20;
    const mention = mentions < 6 && i % 83 === 41;
    const body = mention
      ? `@${SELF} look at this ${mentions++}`
      : turn % 5 === 1
        ? (repeated[Math.floor(turn / 5)] ?? "")
        : `line ${i}`;
    lines.push({ message: msg(i + 1, body, i % 30, at), mention });
  }
  return lines;
}

function maxPerSecond(times: readonly number[]): number {
  let max = 0;
  for (let i = 0, j = 0; i < times.length; i++) {
    if (j < i) j = i;
    while (j + 1 < times.length && (times[j + 1] ?? 0) - (times[i] ?? 0) < 1_000) j++;
    max = Math.max(max, j - i + 1);
  }
  return max;
}

afterEach(() => vi.useRealTimers());

describe("Calm Chat under a 50 msg/s flood", () => {
  for (const start of [0, 130, 230])
    it(`never shows more than 3 new rows a second, mentions aside (flood starts ${start} ms into a tick)`, () => {
      vi.useFakeTimers({ now: T0 });
      let rows: ChatRow[] = [];
      const { result, rerender } = renderHook(
        (p: { rows: ChatRow[] }) =>
          useCalm({
            rows: p.rows,
            enabled: true,
            rowsPerSecond: 3,
            subscriberPriority: false,
            self: SELF,
            now: () => Date.now(),
          }),
        { initialProps: { rows } },
      );
      const lines = floodLines(start);
      const mentionIds = new Set(lines.filter((l) => l.mention).map((l) => l.message.id));
      const seen = new Set<string>();
      const appeared: { id: string; t: number }[] = [];
      const record = () => {
        for (const r of result.current.rows ?? []) {
          const id = r.kind === "wave" ? r.wave.id : r.row.id;
          if (seen.has(id)) continue;
          seen.add(id);
          appeared.push({ id, t: Date.now() - T0 });
        }
      };
      act(() => void vi.advanceTimersByTime(start));
      for (const { message } of lines) {
        const wait = Date.parse(message.createdAt) - Date.now();
        if (wait > 0) act(() => void vi.advanceTimersByTime(wait));
        record();
        const next: ChatRow = { kind: "message", id: message.id, message, deleted: false };
        rows = [...rows, next].slice(-MAX_MESSAGES);
        act(() => rerender({ rows }));
        record();
      }
      for (let i = 0; i < 40; i++) {
        act(() => void vi.advanceTimersByTime(250));
        record();
      }

      const governed = appeared.filter((a) => !mentionIds.has(a.id)).map((a) => a.t);
      expect(maxPerSecond(governed)).toBeLessThanOrEqual(3);
      expect([...mentionIds].filter((id) => !seen.has(id))).toEqual([]);
      // Each repeated body is one row: it never comes back under a later copy's id.
      const waves = (result.current.rows ?? []).filter((r) => r.kind === "wave");
      expect(waves.length).toBeLessThanOrEqual(3);
      expect(governed.length).toBeGreaterThan(20);
    });
});
