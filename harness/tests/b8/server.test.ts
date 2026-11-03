// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** B8-server's harness extensions: their pure checks (`src/b8/server.ts`). */
import { describe, expect, test } from "vite-plus/test";
import {
  apiMintedDelete,
  CASE_REF,
  FIELD_CHOICES_KEPT,
  FIELD_CHOICES_UNTICKED,
  giveawayFileProblems,
} from "../../src/b8/server.ts";

const ACTOR = "https://air.example.test/ap/channels/0190f0f0-0000-7000-8000-00000000aaaa";

describe("actor-disabled-event", () => {
  test("only the id the API used to mint counts as the API's Delete", () => {
    expect(apiMintedDelete(`${ACTOR}#delete-0190f0f0-0000-7000-8000-00000000bbbb`)).toBe(true);
    // The relay's stable id per key generation, and the fan-out's per event.
    expect(apiMintedDelete(`${ACTOR}#delete/key-1730000000000`)).toBe(false);
    expect(apiMintedDelete(`${ACTOR}#delete/0190f0f0-0000-7000-8000-00000000cccc`)).toBe(false);
    expect(apiMintedDelete(undefined)).toBe(false);
  });
});

describe("field-choices", () => {
  test("the kept and unticked fields cover every channel field once", () => {
    const all = [...FIELD_CHOICES_KEPT, ...FIELD_CHOICES_UNTICKED].sort();
    expect(all).toEqual(["category", "description", "language", "mature", "tags", "title"]);
  });
});

describe("giveaway-section", () => {
  const want = { title: "Harness abc", pseudonym: "pmine", rank: 1 };
  const good = {
    entries: [{ giveawayId: "g", giveawayTitle: "Harness abc", channelSlug: "s", enteredAt: "t", pseudonym: "pmine" }],
    wins: [{ giveawayId: "g", giveawayTitle: "Harness abc", channelSlug: "s", rank: 1, drawnAt: "t" }],
  };

  test("the caller's own entry and win pass", () => {
    expect(giveawayFileProblems(good, want, ["ptheirs", "salt0123", "seed0123"])).toEqual([]);
  });

  test("another pseudonym, the salt, a missing win or the wrong shape are named", () => {
    expect(
      giveawayFileProblems(
        { ...good, entries: [...good.entries, { ...good.entries[0], pseudonym: "ptheirs" }] },
        want,
        ["ptheirs"],
      ),
    ).toEqual(["entries 2", "a secret or another member's row"]);
    expect(giveawayFileProblems({ ...good, salt: "salt0123" }, want, ["salt0123"])).toEqual([
      "a secret or another member's row",
    ]);
    expect(giveawayFileProblems({ ...good, wins: [] }, want, [])).toEqual(["wins"]);
    expect(giveawayFileProblems([], want, [])).toEqual(["shape"]);
  });
});

describe("sor-staff-action", () => {
  test("a case or mod-action reference is caught; the statement reference is not", () => {
    expect(CASE_REF.test("reviewed case MA-0A1B2C3D")).toBe(true);
    expect(CASE_REF.test("case MC-DEADBEEF")).toBe(true);
    expect(CASE_REF.test("Reference SR-0A1B2C3D")).toBe(false);
  });
});
