// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** w5-schedule: every schedule selector the harness names is a test id in the web app's source. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { TEST_IDS, W5_SCHEDULE_IDS, W5_SCHEDULE_ROUTES } from "../src/web/selectors.ts";

const WEB = join(import.meta.dirname, "../../apps/web/src");
const FILES = [
  "routes/_studio.tsx",
  "components/schedule/schedule-editor.tsx",
  "components/schedule/about-schedule.tsx",
  "components/schedule/calendar-links.tsx",
  "components/channel/offline-hero.tsx",
];
const source = FILES.map((f) => readFileSync(join(WEB, f), "utf8")).join("\n");

describe("W5_SCHEDULE_IDS", () => {
  test.each(Object.entries(W5_SCHEDULE_IDS))("%s (%s) is a test id in the schedule's source", (_name, id) => {
    // As a JSX attribute, or as the literal a shared field component puts on its control.
    expect(source).toMatch(new RegExp(`(data-testid|testId|retryTestId)=\\{?["'\`]${id}["'\`]`));
  });

  test("the values are unique and do not collide with the shared ids", () => {
    const values = Object.values(W5_SCHEDULE_IDS);
    expect(new Set(values).size).toBe(values.length);
    const shared = new Set<string>(Object.values(TEST_IDS));
    expect(values.filter((v) => shared.has(v))).toEqual([]);
  });

  test("routes", () => {
    expect(W5_SCHEDULE_ROUTES.studioSchedule).toBe("/schedule");
  });
});
