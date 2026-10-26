// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Socket activation end to end: this process opens the listening sockets (as systemd does),
 * hands them to a gateway process as fds 3 and 4 with LISTEN_PID set by `exec` (so it is the
 * gateway's own pid), then closes its copies. Plain and TLS clients connect, and two source
 * addresses count as two clients for the per-address cap.
 */
import net from "node:net";
import tls from "node:tls";
import type { TCPSocketListener } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { REFUSAL_TEXT } from "../src/admission.ts";
import { generateSelfSignedCert } from "../src/tls.ts";
import { PROBE_SCRIPT, judgeProbe, parseProbe, probePlan } from "../../../scripts/selfhost/e2e-irc.ts";
import { startFakeUpstream } from "./helpers/fake-upstream.ts";

const users = {
  "viewer-token": { id: "0190f1c2-0000-7000-8000-000000000002", username: "viewer", displayName: "Viewer" },
};
const MAX_PER_IP = 2;
const material = generateSelfSignedCert();
const HELPER = new URL("./helpers/fd-gateway.ts", import.meta.url).pathname;

interface Source {
  /** Address to connect to and the local address to connect from. */
  host: string;
  local: string;
}

/** A tiny line client that can pick its source address (Bun.connect cannot). */
function client(port: number, src: Source, secure: boolean) {
  const lines: string[] = [];
  let buf = "";
  const waiters = new Set<() => void>();
  const opts = { host: src.host, port, localAddress: src.local };
  const sock = secure ? tls.connect({ ...opts, ca: material.cert, servername: "localhost" }) : net.connect(opts);
  const ready = new Promise<void>((resolve, reject) => {
    sock.once(secure ? "secureConnect" : "connect", () => resolve());
    sock.once("error", reject);
  });
  sock.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\r\n")) !== -1) {
      lines.push(buf.slice(0, nl));
      buf = buf.slice(nl + 2);
    }
    for (const w of waiters) w();
  });
  sock.on("error", () => {});
  return {
    ready,
    socket: sock,
    send: (...ls: string[]) => sock.write(ls.map((l) => `${l}\r\n`).join("")),
    /** The first line matching `re`. */
    waitFor: (re: RegExp, ms = 3000) =>
      new Promise<string>((resolve, reject) => {
        const check = () => {
          const hit = lines.find((l) => re.test(l));
          if (hit === undefined) return;
          waiters.delete(check);
          clearTimeout(timer);
          resolve(hit);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`no ${re} in:\n${lines.join("\n")}`));
        }, ms);
        waiters.add(check);
        check();
      }),
    close: () => sock.destroy(),
  };
}

const register = async (c: ReturnType<typeof client>) => {
  await c.ready;
  c.send("PASS oauth:viewer-token", "NICK viewer");
  return c.waitFor(/^:\S+ (376|ERROR)|^ERROR /);
};

/** Distinct loopback sources: 127.0.0.2/3 on Linux; macOS has only 127.0.0.1, so it and ::1. */
async function pickSources(port: number): Promise<[Source, Source]> {
  const works = await new Promise<boolean>((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port, localAddress: "127.0.0.2" });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
  return works
    ? [
        { host: "127.0.0.1", local: "127.0.0.2" },
        { host: "127.0.0.1", local: "127.0.0.3" },
      ]
    : [
        { host: "127.0.0.1", local: "127.0.0.1" },
        { host: "::1", local: "::1" },
      ];
}

let upstream: ReturnType<typeof startFakeUpstream>;
let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "inherit">>;
let ports: { tcp: number; tls: number };
let sources: [Source, Source];
let ready: { activation: unknown; ports: unknown; envLeft: string[] };

beforeAll(async () => {
  upstream = startFakeUpstream(users);
  // Dual-stack, like BindIPv6Only=both. The handlers never run: no client connects before the
  // child owns the sockets, except the source probe, which this process answers.
  const listen = () =>
    Bun.listen({
      hostname: "::",
      port: 0,
      socket: { open: (s) => void s.end(), data() {} },
    }) as TCPSocketListener<undefined> & { fd: number };
  const plain = listen();
  const secure = listen();
  ports = { tcp: plain.port, tls: secure.port };
  sources = await pickSources(plain.port);
  // `exec` keeps the shell's pid, so LISTEN_PID=$$ is the gateway's own pid, as systemd sets it.
  // The names come in the other order than the descriptors' ports, so only the names place them.
  child = Bun.spawn(
    [
      "/bin/sh",
      "-c",
      'LISTEN_PID=$$ LISTEN_FDS=2 LISTEN_FDNAMES=ircs:irc exec "$0" "$1" "$2" "$3"',
      process.execPath,
      HELPER,
      upstream.url,
      String(MAX_PER_IP),
    ],
    {
      stdio: ["ignore", "pipe", "inherit", secure.fd, plain.fd],
      env: { ...process.env, IRC_TEST_CERT: material.cert, IRC_TEST_KEY: material.key },
    },
  );
  const reader = child.stdout.getReader();
  let out = "";
  while (!out.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  ready = JSON.parse(out.split("\n")[0] ?? "{}") as typeof ready;
  // The gateway now holds its own copies; close ours so only it accepts.
  plain.stop(true);
  secure.stop(true);
}, 15_000);

afterAll(async () => {
  child?.kill("SIGTERM");
  await child?.exited;
  await upstream?.stop();
});

describe("a gateway on inherited listening sockets", () => {
  test("found both by name, reports the configured ports, and unset the variables", () => {
    expect(ready.activation).toEqual({ kind: "fds", tcp: 4, tls: 3 });
    expect(ready.ports).toEqual({ tcp: 6667, tls: 6697, ws: null });
    expect(ready.envLeft).toEqual([]);
  });

  test("accepts a plain client and a TLS client (certificate verified)", async () => {
    const a = client(ports.tcp, sources[0], false);
    expect(await register(a)).toMatch(/ 376 /);
    const b = client(ports.tls, sources[0], true);
    expect(await register(b)).toMatch(/ 376 /);
    expect((b.socket as tls.TLSSocket).authorized).toBe(true);
    a.close();
    b.close();
    await Bun.sleep(100);
  });

  test("two source addresses count as two clients for the per-address cap", async () => {
    const [one, two] = sources;
    const held = [client(ports.tcp, one, false), client(ports.tls, one, true)];
    for (const c of held) expect(await register(c)).toMatch(/ 376 /);
    const over = client(ports.tcp, one, false);
    await over.ready;
    expect(await over.waitFor(/^ERROR /)).toBe(`ERROR :Closing Link: ${REFUSAL_TEXT.too_many_from_ip}`);
    expect(REFUSAL_TEXT.too_many_from_ip).toBe("Too many connections from your address");
    const other = client(ports.tls, two, true);
    expect(await register(other)).toMatch(/ 376 /);
    for (const c of [...held, over, other]) c.close();
  });

  test("the self-host e2e probe (scripts/selfhost/e2e-irc.ts) passes against it", async () => {
    await Bun.sleep(200); // the previous test's connections have gone
    const [one, two] = sources;
    const plan = probePlan({
      ca: material.cert,
      host: "127.0.0.1",
      port: ports.tcp,
      tlsPort: ports.tls,
      sources: { held: one.local, other: two.local, tls: two.local },
      delays: [0, 0],
      laterDelayMs: 0,
      timeoutMs: 3000,
    });
    plan.tls.servername = "localhost";
    const run = Bun.spawn([process.execPath, "-e", PROBE_SCRIPT], {
      env: { ...process.env, IRC_PROBE: JSON.stringify(plan) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(run.stdout).text();
    expect(await run.exited, await new Response(run.stderr).text()).toBe(0);
    const checks = judgeProbe(parseProbe(out), plan);
    expect(checks.filter(([ok]) => !ok)).toEqual([]);
    expect(checks.length).toBe(6);
  });
});
