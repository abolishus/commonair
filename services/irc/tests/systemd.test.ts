// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { openSync, closeSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { FD_NAMES, LISTEN_FDS_START, describeFdNames, socketProblem, systemdListeners } from "../src/systemd.ts";

const PID = 4242;
const run = (vars: Record<string, string>, pid = PID, ppid?: number) => {
  const env: Record<string, string | undefined> = { OTHER: "kept", ...vars };
  const result = systemdListeners(env, pid, ppid);
  return { result, env };
};

describe("systemdListeners", () => {
  test("no variables: not activated", () => {
    expect(run({}).result).toEqual({ kind: "none" });
  });

  test("a LISTEN_PID for another process is ignored (and says why)", () => {
    const { result } = run({ LISTEN_PID: "999", LISTEN_FDS: "2", LISTEN_FDNAMES: "irc:ircs" });
    expect(result.kind).toBe("none");
    expect(result).toHaveProperty("ignored", expect.stringContaining("999"));
  });

  test("LISTEN_FDS=0: not activated", () => {
    expect(run({ LISTEN_PID: String(PID), LISTEN_FDS: "0" }).result).toEqual({ kind: "none", ignored: "LISTEN_FDS=0" });
  });

  test("one fd is not enough: both 6667 and 6697 are needed", () => {
    expect(run({ LISTEN_PID: String(PID), LISTEN_FDS: "1" }).result.kind).toBe("error");
    expect(run({ LISTEN_PID: String(PID), LISTEN_FDS: "1", LISTEN_FDNAMES: "irc" }).result.kind).toBe("error");
    expect(run({ LISTEN_PID: String(PID), LISTEN_FDS: "1", LISTEN_FDNAMES: "ircs" }).result.kind).toBe("error");
  });

  test("two fds without names: fd 3 plain, fd 4 TLS", () => {
    expect(run({ LISTEN_PID: String(PID), LISTEN_FDS: "2" }).result).toEqual({
      kind: "fds",
      tcp: 3,
      tls: 4,
      fdNames: null,
    });
    expect(run({ LISTEN_PID: String(PID), LISTEN_FDS: "2", LISTEN_FDNAMES: "" }).result).toEqual({
      kind: "fds",
      tcp: 3,
      tls: 4,
      fdNames: null,
    });
  });

  test("two fds with names, in either order", () => {
    expect(run({ LISTEN_PID: String(PID), LISTEN_FDS: "2", LISTEN_FDNAMES: "irc:ircs" }).result).toEqual({
      kind: "fds",
      tcp: 3,
      tls: 4,
      fdNames: "irc:ircs",
    });
    expect(run({ LISTEN_PID: String(PID), LISTEN_FDS: "2", LISTEN_FDNAMES: "ircs:irc" }).result).toEqual({
      kind: "fds",
      tcp: 4,
      tls: 3,
      fdNames: "ircs:irc",
    });
  });

  test("names are the socket units' FileDescriptorName= and fds start at 3", () => {
    expect(FD_NAMES).toEqual({ tcp: "irc", tls: "ircs" });
    expect(LISTEN_FDS_START).toBe(3);
  });

  test("Podman's LISTEN_PID=1 counts when the parent is the container init (catatonit)", () => {
    const vars = { LISTEN_PID: "1", LISTEN_FDS: "2", LISTEN_FDNAMES: "irc:ircs" };
    expect(run(vars, 2, 1).result).toEqual({ kind: "fds", tcp: 3, tls: 4, fdNames: "irc:ircs" });
    // Bun as pid 1 itself (no init).
    expect(run(vars, 1, 0).result).toEqual({ kind: "fds", tcp: 3, tls: 4, fdNames: "irc:ircs" });
    // Not under the init: meant for someone else.
    expect(run(vars, 2, 77).result.kind).toBe("none");
  });

  test.each([
    [{ LISTEN_PID: String(PID), LISTEN_FDS: "two" }, "not a count"],
    [{ LISTEN_PID: String(PID), LISTEN_FDS: "-1" }, "not a count"],
    [{ LISTEN_PID: String(PID), LISTEN_FDS: "" }, "not a count"],
    [{ LISTEN_PID: "abc", LISTEN_FDS: "2" }, "not a process id"],
    [{ LISTEN_FDS: "2" }, "without LISTEN_PID"],
    [{ LISTEN_PID: String(PID), LISTEN_FDS: "2", LISTEN_FDNAMES: "irc" }, "1 names for 2"],
    [{ LISTEN_PID: String(PID), LISTEN_FDS: "2", LISTEN_FDNAMES: "irc:http" }, "unknown socket names: http"],
    [{ LISTEN_PID: String(PID), LISTEN_FDS: "2", LISTEN_FDNAMES: "irc:irc" }, "exactly one"],
    [{ LISTEN_PID: String(PID), LISTEN_FDS: "3", LISTEN_FDNAMES: "irc:ircs:irc" }, "exactly one"],
    [{ LISTEN_PID: String(PID), LISTEN_FDS: "3" }, "expected 2 unnamed"],
  ])("garbage %o is an error (%s)", (vars, reason) => {
    const { result } = run(vars);
    expect(result.kind).toBe("error");
    expect(result).toHaveProperty("reason", expect.stringContaining(reason));
  });

  test.each<Record<string, string>>([
    {},
    { LISTEN_PID: String(PID), LISTEN_FDS: "2", LISTEN_FDNAMES: "irc:ircs" },
    { LISTEN_PID: "999", LISTEN_FDS: "2" },
    { LISTEN_PID: String(PID), LISTEN_FDS: "nope" },
  ])("the variables are unset afterwards (%o)", (vars) => {
    const { env } = run(vars);
    expect(env).toEqual({ OTHER: "kept" });
  });
});

describe("describeFdNames", () => {
  test("the names received, or the unnamed fd-order fallback", () => {
    expect(describeFdNames("irc:ircs")).toBe("irc:ircs");
    expect(describeFdNames("ircs:irc")).toBe("ircs:irc");
    expect(describeFdNames(null)).toBe("unnamed, fd-order fallback");
    expect(describeFdNames(undefined)).toBe("unnamed, fd-order fallback");
    expect(describeFdNames("")).toBe("unnamed, fd-order fallback");
  });
});

describe("socketProblem", () => {
  test("a closed descriptor and a regular file are refused", () => {
    expect(socketProblem(987_654)).toMatch(/fd 987654 is not open/);
    const fd = openSync(new URL(import.meta.url).pathname, "r");
    try {
      expect(socketProblem(fd)).toBe(`fd ${fd} is not a socket`);
    } finally {
      closeSync(fd);
    }
  });

  test("a listening socket is fine", () => {
    const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      const fd = (l as unknown as { fd: number }).fd;
      expect(socketProblem(fd)).toBeNull();
    } finally {
      l.stop(true);
    }
  });
});
