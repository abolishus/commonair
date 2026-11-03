// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { PORT_RACE_ATTEMPTS, isPortRace, podmanName, publishesPorts, retryPortRace } from "../test-podman.ts";

const RACE = "Error: rootlessport listen udp 127.0.0.1:37877: bind: address already in use";
const RUN = ["run", "-d", "--name", "c1", "-p", "127.0.0.1::8890/udp", "img"];

/** `retryPortRace` over scripted attempt outcomes (undefined = success), recording removals. */
function scripted(args: readonly string[], outcomes: (string | undefined)[]) {
  const removed: string[] = [];
  let calls = 0;
  const result = retryPortRace(
    args,
    () => outcomes[Math.min(calls++, outcomes.length - 1)],
    (r) => r,
    (name) => removed.push(name),
  );
  return { result, calls, removed };
}

describe("isPortRace", () => {
  test("matches podman's bind failure, in any case", () => {
    expect(isPortRace(RACE)).toBe(true);
    expect(isPortRace("listen tcp 127.0.0.1:5432: Address already in use")).toBe(true);
  });
  test("does not match other failures", () => {
    expect(isPortRace("Error: image not known")).toBe(false);
    expect(isPortRace("")).toBe(false);
  });
});

describe("podmanName", () => {
  test("reads --name <name> and --name=<name>", () => {
    expect(podmanName(RUN)).toBe("c1");
    expect(podmanName(["run", "--name=c2", "img"])).toBe("c2");
  });
  test("is undefined without a name", () => {
    expect(podmanName(["run", "img"])).toBeUndefined();
    expect(podmanName(["run", "--name"])).toBeUndefined();
  });
});

describe("publishesPorts", () => {
  test("a run with -p, -p<spec>, --publish or --publish=<spec>", () => {
    expect(publishesPorts(RUN)).toBe(true);
    expect(publishesPorts(["run", "-p127.0.0.1::80", "img"])).toBe(true);
    expect(publishesPorts(["run", "--publish", "127.0.0.1::80", "img"])).toBe(true);
    expect(publishesPorts(["run", "--publish=127.0.0.1::80", "img"])).toBe(true);
  });
  test("not a run without ports, nor anything but run", () => {
    expect(publishesPorts(["run", "--pod", "p", "--name", "c", "img"])).toBe(false);
    expect(publishesPorts(["exec", "c", "valkey-cli", "-p", "6380"])).toBe(false);
    expect(publishesPorts(["pod", "create", "-p", "127.0.0.1::80"])).toBe(false);
    expect(publishesPorts([])).toBe(false);
  });
});

describe("retryPortRace", () => {
  test("a success runs once and removes nothing", () => {
    expect(scripted(RUN, [undefined])).toEqual({ result: undefined, calls: 1, removed: [] });
  });

  test("a lost race removes the container and retries until it starts", () => {
    expect(scripted(RUN, [RACE, RACE, undefined])).toEqual({ result: undefined, calls: 3, removed: ["c1", "c1"] });
  });

  test("gives up after PORT_RACE_ATTEMPTS lost races and returns the last failure", () => {
    const r = scripted(RUN, [RACE]);
    expect(r.result).toBe(RACE);
    expect(r.calls).toBe(PORT_RACE_ATTEMPTS);
    expect(r.removed).toHaveLength(PORT_RACE_ATTEMPTS - 1);
  });

  test("any other failure is returned at once", () => {
    expect(scripted(RUN, ["Error: image not known"])).toEqual({
      result: "Error: image not known",
      calls: 1,
      removed: [],
    });
  });

  test("a race is not retried for a run without published ports or without a name", () => {
    expect(scripted(["run", "--rm", "--name", "c", "img"], [RACE]).calls).toBe(1);
    expect(scripted(["run", "-p", "127.0.0.1::80", "img"], [RACE]).calls).toBe(1);
    expect(scripted(["exec", "c", "true"], [RACE]).calls).toBe(1);
  });
});
