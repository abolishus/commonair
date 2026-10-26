// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * IRC's socket units (infra/systemd/commonair-irc.socket, commonair-ircs.socket) against the
 * unit's ports and what the gateway's `systemdListeners` expects (services/irc/src/systemd.ts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { FD_NAMES, systemdListeners } from "../../services/irc/src/systemd.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const values = (text: string, key: string) => [...text.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))].map((m) => m[1]!);
const env = (text: string, key: string) =>
  values(text, "Environment")
    .filter((e) => e.startsWith(`${key}=`))
    .map((e) => e.slice(key.length + 1));

const unit = read("infra/quadlet/commonair-irc.container");
const plain = read("infra/systemd/commonair-irc.socket");
const tls = read("infra/systemd/commonair-ircs.socket");

describe("IRC socket units", () => {
  test("the ports equal the unit's IRC_PORT and IRC_TLS_PORT", () => {
    expect(values(plain, "ListenStream")).toEqual(env(unit, "IRC_PORT"));
    expect(values(tls, "ListenStream")).toEqual(env(unit, "IRC_TLS_PORT"));
    expect(env(unit, "IRC_PORT")).toEqual(["6667"]);
    expect(env(unit, "IRC_TLS_PORT")).toEqual(["6697"]);
  });

  test("dual-stack, started at boot", () => {
    for (const s of [plain, tls]) {
      expect(values(s, "BindIPv6Only")).toEqual(["both"]);
      expect(values(s, "WantedBy")).toEqual(["sockets.target"]);
      // One listening socket per connection-less unit: systemd must not accept for the gateway.
      expect(values(s, "Accept")).toEqual([]);
    }
  });

  test("the descriptor names are the ones the gateway looks for", () => {
    expect(values(plain, "FileDescriptorName")).toEqual([FD_NAMES.tcp]);
    expect(values(tls, "FileDescriptorName")).toEqual([FD_NAMES.tls]);
  });

  test("both go to commonair-irc.service, which takes both", () => {
    // commonair-irc.socket by its name; the TLS one by Service=.
    expect(values(plain, "Service")).toEqual([]);
    expect(values(tls, "Service")).toEqual(["commonair-irc.service"]);
    expect(values(unit, "Sockets")).toEqual(["commonair-irc.socket commonair-ircs.socket"]);
  });

  test("whatever order systemd passes them in, the gateway places them by name", () => {
    const names = [values(plain, "FileDescriptorName")[0], values(tls, "FileDescriptorName")[0]];
    const pass = (order: (string | undefined)[]) =>
      systemdListeners({ LISTEN_PID: "7", LISTEN_FDS: "2", LISTEN_FDNAMES: order.join(":") }, 7);
    expect(pass(names)).toEqual({ kind: "fds", tcp: 3, tls: 4, fdNames: "irc:ircs" });
    expect(pass([...names].reverse())).toEqual({ kind: "fds", tcp: 4, tls: 3, fdNames: "ircs:irc" });
  });
});
