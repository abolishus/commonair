// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The pure parts of scripts/selfhost/e2e-dump.ts: the seeded dates, the scripts' text (no key
 * in any of it) and the checks' flow against a fake host. The checks themselves run in the
 * self-host e2e.
 */
import { describe, expect, test } from "vite-plus/test";
import { OFFSITE, OFFSITE_KEY } from "./e2e-backup.ts";
import {
  DUMPS_DIR,
  DUMP_KEEP,
  checkDumps,
  checkWalgDrill,
  drillQuery,
  dumpShaScript,
  listScript,
  result,
  seedDates,
  seedScript,
  teardownScript,
} from "./e2e-dump.ts";

const promAnswer = (v: number) =>
  JSON.stringify({ status: "success", data: { resultType: "vector", result: [{ value: [0, String(v)] }] } });

describe("e2e-dump's scripts", () => {
  test("the dumps live under the offsite store's prefix, as selfhost.sh puts them", () => {
    expect(DUMPS_DIR).toBe(`${OFFSITE.bucket}/${OFFSITE.prefix}/dumps`);
    expect(DUMP_KEEP).toBe(30);
  });

  test("seeded dates are consecutive days before the given one, oldest first", () => {
    const d = seedDates(30, "2026-11-03");
    expect(d).toHaveLength(30);
    expect(d[29]).toBe("2026-11-02");
    expect(d[0]).toBe("2026-10-04");
    expect([...d].sort()).toEqual(d);
  });

  test("no key in any script's text, and dates are validated", () => {
    for (const s of [
      seedScript(seedDates(3, "2026-11-03")),
      listScript(),
      dumpShaScript("2026-11-03"),
      teardownScript(),
    ]) {
      expect(s).not.toContain(OFFSITE_KEY.id);
      expect(s).not.toContain(OFFSITE_KEY.secret);
    }
    expect(() => seedScript(["2026-11-03; rm -rf /"])).toThrow("not a dump date");
    expect(() => dumpShaScript("../x")).toThrow("not a dump date");
  });

  test("each seeded dump gets a sidecar, so retention counts it as complete", () => {
    const s = seedScript(["2026-10-01"]);
    expect(s).toContain(`rclone rcat "off:$dumps/$d/commonair.dump"`);
    expect(s).toContain(`rclone rcat "off:$dumps/$d/commonair.dump.sha256"`);
  });

  test("result() reads the exit status and seconds", () => {
    expect(result("x\nexit=0 seconds=12\n")).toMatchObject({ code: 0, seconds: 12 });
    expect(result("garbled").code).toBe(-1);
  });

  test("the gauge queries look back an hour, per kind", () => {
    expect(drillQuery("seconds", "dump")).toBe('max(max_over_time(commonair_restore_drill_seconds{kind="dump"}[1h]))');
    expect(drillQuery("success", "walg")).toBe('max(max_over_time(commonair_restore_drill_success{kind="walg"}[1h]))');
  });
});

describe("the checks' flow", () => {
  test("checkDumps passes on a host that does what selfhost.sh does", async () => {
    const date = new Date().toISOString().slice(0, 10);
    const sha = "ab".repeat(32);
    const seeded = seedDates(30, date);
    const failures: string[] = [];
    const inHost = (script: string) => {
      if (script.includes("backup --dump")) return "dump done\nexit=0 seconds=3\n";
      if (script.includes("backup --drill")) return "  all 40 checks match\nexit=0 seconds=9\n";
      if (script.includes('commonair.dump.sha256" | cut')) return `${sha} ${sha} 1234 40\n`;
      if (script.startsWith("cat ") && script.endsWith("/db-dump"))
        return `LAST_SUCCESS=${date}T02:10:00Z\nDUMP=${date}\nSHA256=${sha}\n`;
      if (script.endsWith("/restore-drill-dump")) return "RESULT=success\n";
      if (script.includes("selfhost.sh status")) return `last dump: ${date}T02:10:00Z, 1.2 KiB\n`;
      if (script.includes("is-enabled")) return "enabled\n";
      if (script.includes("podman ps -a")) return "";
      if (script.includes("api/v1/query")) return promAnswer(1);
      if (script.includes("echo seeded")) return "seeded\n";
      if (script.includes("--dirs-only")) return `${[...seeded.slice(1), date].join("\n")}\n`;
      return "";
    };
    await checkDumps(inHost, (ok, what) => void (ok || failures.push(what)), { timeoutMs: 0 });
    expect(failures).toEqual([]);
  });

  test("checkDumps fails when retention left 31", async () => {
    const date = new Date().toISOString().slice(0, 10);
    const seeded = seedDates(30, date);
    const failures: string[] = [];
    const inHost = (script: string) => {
      if (script.includes("--dirs-only")) return `${[...seeded, date].join("\n")}\n`;
      if (script.includes("api/v1/query")) return promAnswer(1);
      return "exit=0 seconds=1\n";
    };
    await checkDumps(inHost, (ok, what) => void (ok || failures.push(what)), { timeoutMs: 0 });
    expect(failures).toContain("30 dumps stay (31)");
    expect(failures).toContain(`the oldest (${seeded[0]}) was deleted`);
  });

  test("checkWalgDrill starts the timer's service once and reads its gauges", async () => {
    const scripts: string[] = [];
    const failures: string[] = [];
    const inHost = (script: string) => {
      scripts.push(script);
      if (script.includes("is-enabled")) return "enabled\n";
      if (script.includes("--property=Result")) return "success\n";
      if (script.endsWith("/restore-drill-walg")) return "RESULT=success\n";
      if (script.includes("api/v1/query")) return promAnswer(1);
      return "";
    };
    await checkWalgDrill(inHost, (ok, what) => void (ok || failures.push(what)), { timeoutMs: 0 });
    expect(failures).toEqual([]);
    expect(scripts.filter((s) => s === "systemctl --user start commonair-drill-walg.service")).toHaveLength(1);
  });
});
