// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `ImportChoices.fields` (batch 8, N3-import request 5): which channel fields an import applies. */
import { describe, expect, test } from "vite-plus/test";
import { CHANNEL_FIELDS, chosenFields } from "../src/portability/import/apply.ts";

describe("chosenFields", () => {
  test("absent fields mean every field, as bundle imports always had", () => {
    expect([...chosenFields({ channel: true })]).toEqual([...CHANNEL_FIELDS]);
  });

  test("present fields apply only those set to true", () => {
    expect([...chosenFields({ channel: true, fields: { title: true, tags: true, mature: false } })]).toEqual([
      "title",
      "tags",
    ]);
    expect(chosenFields({ channel: true, fields: {} }).size).toBe(0);
  });

  test("nothing applies when the channel is not chosen", () => {
    expect(chosenFields({ channel: false }).size).toBe(0);
    expect(chosenFields({ channel: false, fields: { title: true } }).size).toBe(0);
  });
});
