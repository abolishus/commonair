// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  CHECKPOINT_VERSION,
  type SeedCheckpoint,
  checkpointFileName,
  clearCheckpoints,
  parseCheckpoint,
  readCheckpoint,
  resumeRefusals,
  selectUnits,
  writeCheckpoint,
} from "../../src/seed/checkpoint.ts";
import type { SeedUnit, SeedUnitName } from "../../src/seed/types.ts";
import { SEED_UNITS, orderUnits } from "../../src/seed/units.ts";

const fingerprint = { users: 2000, usersHash: "0123456789abcdef0123456789abcdef" };
const checkpoint: SeedCheckpoint = {
  version: CHECKPOINT_VERSION,
  unit: "safety",
  target: "postgres:5432/commonair",
  scale: "medium",
  seed: 1,
  now: "2026-11-02T23:30:00.000Z",
  fingerprint,
  store: {
    users: [
      { id: "u1", handle: "streamer1", username: "demo_streamer1", email: "e", kind: "fixed", platformRole: "user" },
    ],
    channels: [{ id: "c1", ownerId: "u1", ownerHandle: "streamer1", slug: "demo_streamer1" }],
    extra: { social: { botUserId: "b1" }, media: { chatWindows: [{ start: "2026-11-01T00:00:00.000Z" }] } },
  },
};

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "seed-checkpoint-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("checkpoint files", () => {
  test("round-trip: what is written reads back equal", () => {
    const dir = tempDir();
    const file = writeCheckpoint(dir, checkpoint);
    expect(file).toBe(join(dir, "seed-checkpoint-safety.json"));
    expect(readCheckpoint(dir, "safety")).toEqual(checkpoint);
  });

  test("no file is undefined, not an error", () => {
    expect(readCheckpoint(tempDir(), "coop")).toBeUndefined();
    expect(readCheckpoint(join(tempDir(), "missing"), "coop")).toBeUndefined();
  });

  test("a torn or foreign file is refused with a reason", () => {
    expect(() => parseCheckpoint("{", "f")).toThrow("f is not JSON");
    expect(() => parseCheckpoint("null")).toThrow("not an object");
    expect(() => parseCheckpoint(JSON.stringify({ ...checkpoint, version: 99 }))).toThrow("version 99");
    expect(() => parseCheckpoint(JSON.stringify({ ...checkpoint, unit: "nope" }))).toThrow("unknown unit");
    expect(() => parseCheckpoint(JSON.stringify({ ...checkpoint, seed: "1" }))).toThrow("target, scale or seed");
    expect(() => parseCheckpoint(JSON.stringify({ ...checkpoint, now: "yesterday" }))).toThrow("now");
    expect(() => parseCheckpoint(JSON.stringify({ ...checkpoint, fingerprint: { users: 1 } }))).toThrow("fingerprint");
    expect(() => parseCheckpoint(JSON.stringify({ ...checkpoint, store: { users: [] } }))).toThrow("store");
    const dir = tempDir();
    writeFileSync(join(dir, checkpointFileName("money")), "not json");
    expect(() => readCheckpoint(dir, "money")).toThrow("is not JSON");
  });

  test("clear removes only checkpoints", () => {
    const dir = tempDir();
    writeCheckpoint(dir, checkpoint);
    writeCheckpoint(dir, { ...checkpoint, unit: "social" });
    writeFileSync(join(dir, "seed-store.json"), "{}");
    writeFileSync(join(dir, "seed-live.log"), "");
    clearCheckpoints(dir);
    expect(readdirSync(dir).sort()).toEqual(["seed-live.log", "seed-store.json"]);
    clearCheckpoints(join(dir, "missing"));
  });
});

describe("selectUnits", () => {
  const ordered = orderUnits(SEED_UNITS);
  const names = (us: readonly SeedUnit[]) => us.map((u) => u.name);
  const all = names(ordered);

  test("the run order puts every dependency first", () => {
    expect(all).toEqual(["social", "interact", "money", "media", "safety", "coop", "platform", "schedule"]);
  });

  test("no flags: every unit, from the start", () => {
    expect(selectUnits(ordered)).toEqual({ resumeAfter: undefined, run: ordered, reachesEnd: true });
  });

  test("--from resumes after the unit before it", () => {
    const s = selectUnits(ordered, "coop");
    expect(s.resumeAfter).toBe("safety");
    expect(names(s.run)).toEqual(["coop", "platform", "schedule"]);
    expect(s.reachesEnd).toBe(true);
    // The first unit is a fresh run.
    expect(selectUnits(ordered, "social").resumeAfter).toBeUndefined();
  });

  test("--to stops early; --from and --to together run one unit", () => {
    const s = selectUnits(ordered, undefined, "social");
    expect(names(s.run)).toEqual(["social"]);
    expect(s.reachesEnd).toBe(false);
    const one = selectUnits(ordered, "media", "media");
    expect([one.resumeAfter, names(one.run), one.reachesEnd]).toEqual(["money", ["media"], false]);
    expect(selectUnits(ordered, "platform", "platform").reachesEnd).toBe(false);
    expect(selectUnits(ordered, "schedule", "schedule").reachesEnd).toBe(true);
  });

  test("--to before --from, or a unit not in the order, throws", () => {
    expect(() => selectUnits(ordered, "coop", "money")).toThrow("runs before");
    expect(() => selectUnits(ordered.slice(0, 2), "coop" as SeedUnitName)).toThrow("no unit coop");
  });
});

describe("resumeRefusals", () => {
  const ok = {
    after: "safety" as const,
    checkpoint,
    target: checkpoint.target,
    scale: "medium" as const,
    seed: 1,
    fingerprint,
  };

  test("a checkpoint matching this database: no refusal", () => {
    expect(resumeRefusals(ok)).toEqual([]);
  });

  test("no checkpoint refuses (a non-seed database never has one)", () => {
    expect(resumeRefusals({ ...ok, checkpoint: undefined })).toEqual([
      expect.stringContaining("no checkpoint after seed-safety"),
    ]);
  });

  test("each mismatch is its own reason", () => {
    expect(resumeRefusals({ ...ok, after: "media" })).toEqual([expect.stringContaining("after seed-safety, not")]);
    expect(resumeRefusals({ ...ok, target: "db:5432/other" })).toEqual([expect.stringContaining("is for postgres")]);
    expect(resumeRefusals({ ...ok, scale: "small" })).toEqual([expect.stringContaining("--scale medium --seed 1")]);
    expect(resumeRefusals({ ...ok, seed: 2 })).toHaveLength(1);
  });

  test("other users, or the same count with other ids, mean the snapshot was not restored", () => {
    expect(resumeRefusals({ ...ok, fingerprint: { ...fingerprint, users: 2001 } })).toEqual([
      expect.stringContaining("restore the snapshot taken after seed-safety"),
    ]);
    expect(resumeRefusals({ ...ok, fingerprint: { ...fingerprint, usersHash: "ffff" } })).toHaveLength(1);
    expect(resumeRefusals({ ...ok, fingerprint: { users: 3, usersHash: "x" }, target: "a/b", seed: 5 })).toHaveLength(
      3,
    );
  });
});
