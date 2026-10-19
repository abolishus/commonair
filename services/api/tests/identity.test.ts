// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "vite-plus/test";
import { ageOn, ageProblem, isAdult, parseBirthDate, usernameProblem } from "../src/auth/identity.ts";

const now = new Date("2026-10-18T12:00:00Z");

test("usernames follow slug rules and avoid reserved names", () => {
  expect(usernameProblem("alice_99")).toBeNull();
  expect(usernameProblem("Alice")).toBeNull(); // normalized to lowercase
  expect(usernameProblem("ab")).toBe("format");
  expect(usernameProblem("a".repeat(26))).toBe("format");
  expect(usernameProblem("al-ice")).toBe("format");
  expect(usernameProblem("ali ce")).toBe("format");
  for (const r of ["admin", "api", "www", "mod", "help", "settings", "ADMIN"])
    expect(usernameProblem(r)).toBe("reserved");
  expect(usernameProblem("admin_bob")).toBe("reserved");
});

test("the demo fixture prefix is reserved for every sign-up and bot", () => {
  for (const name of ["demo_streamer1", "DEMO_viewer2", "demo_bot", "demo_x"])
    expect(usernameProblem(name)).toBe("reserved");
  // Only the exact prefix: names that merely contain "demo" stay available.
  for (const name of ["demo", "demos", "demox_1", "my_demo_1", "demo1"]) expect(usernameProblem(name)).toBeNull();
});

test("birth dates must be real calendar dates", () => {
  expect(parseBirthDate("2000-02-29")).toEqual({ y: 2000, m: 2, d: 29 });
  expect(parseBirthDate("2001-02-29")).toBeNull();
  expect(parseBirthDate("2000-13-01")).toBeNull();
  expect(parseBirthDate("2000-1-1")).toBeNull();
  expect(parseBirthDate("1899-12-31")).toBeNull();
  expect(parseBirthDate(20000101)).toBeNull();
});

test("age is whole years on the UTC calendar", () => {
  expect(ageOn({ y: 2013, m: 10, d: 18 }, now)).toBe(13);
  expect(ageOn({ y: 2013, m: 10, d: 19 }, now)).toBe(12);
  expect(ageOn({ y: 2008, m: 10, d: 18 }, now)).toBe(18);
});

test("age gate", () => {
  expect(ageProblem("2013-10-18", 13, now)).toBeNull();
  expect(ageProblem("2013-10-19", 13, now)).toBe("too_young");
  expect(ageProblem(undefined, 13, now)).toBe("missing");
  expect(ageProblem("", 13, now)).toBe("missing");
  expect(ageProblem("not a date", 13, now)).toBe("invalid");
  expect(ageProblem("2030-01-01", 13, now)).toBe("invalid");
  expect(ageProblem("2011-01-01", 16, now)).toBe("too_young");
});

test("adulthood", () => {
  expect(isAdult("2008-10-18", now)).toBe(true);
  expect(isAdult("2008-10-19", now)).toBe(false);
  expect(isAdult(null, now)).toBe(false);
});
