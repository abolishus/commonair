// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createServer, type AddressInfo, type Socket } from "node:net";
import { describe, expect, test } from "vite-plus/test";
import type { Deps } from "../src/deps.ts";
import { outboundUrlProblem, pinnedGet, type OutboundPolicy } from "../src/lib/outbound.ts";
import { healthCheck, relayTargetProblem } from "../src/routes/relays.ts";

const DNS: Record<string, string[]> = {
  "relay.example.test": ["93.184.216.250"],
  "rebind.example.test": ["10.0.0.5"],
  "metadata.example.test": ["169.254.169.254"],
  "mixed.example.test": ["93.184.216.34", "127.0.0.1"],
  "v6.example.test": ["2606:4700:4700::1111"],
  "v6local.example.test": ["fd00::1"],
  "mapped.example.test": ["::ffff:127.0.0.1"],
  "cgnat.example.test": ["100.64.1.1"],
  "live.twitch.example.test": ["93.184.216.35"],
};
const resolve = async (host: string) => {
  const a = DNS[host];
  if (!a) throw new Error("ENOTFOUND");
  return a;
};
const rtmp: OutboundPolicy = { protocols: ["rtmp:", "rtmps:"], allowPrivate: false, resolve };
const https: OutboundPolicy = { protocols: ["https:"], allowPrivate: false, resolve };

describe("outboundUrlProblem (production)", () => {
  test.each([
    "rtmp://live.twitch.example.test/app",
    "rtmps://live.twitch.example.test:443/app",
    "rtmp://93.184.216.34/live",
    "rtmp://[2606:4700:4700::1111]/live",
    "rtmp://v6.example.test/live",
  ])("allows %s", async (url) => {
    expect(await outboundUrlProblem(url, rtmp)).toBeNull();
  });

  test.each([
    ["rtmp://127.0.0.1/live", "non-public address"],
    ["rtmp://10.1.2.3/live", "non-public address"],
    ["rtmp://169.254.169.254/latest", "non-public address"],
    ["rtmp://100.64.0.1/live", "non-public address"],
    ["rtmp://224.0.0.1/live", "non-public address"],
    ["rtmp://[::1]/live", "non-public address"],
    ["rtmp://[::ffff:127.0.0.1]/live", "non-public address"],
    ["rtmp://[::ffff:a9fe:a9fe]/live", "non-public address"],
    ["rtmp://[fe80::1]/live", "non-public address"],
    ["rtmp://[fc00::1]/live", "non-public address"],
    ["rtmp://[64:ff9b::a00:1]/live", "non-public address"],
    ["rtmp://localhost/live", "non-public host"],
    ["rtmp://media.localhost/live", "non-public host"],
    ["rtmp://metadata.google.internal/live", "non-public host"],
    ["rtmp://garage/live", "non-public host"],
    ["rtmp://2130706433/live", "non-canonical numeric host"], // decimal 127.0.0.1
    ["rtmp://0177.0.0.1/live", "non-canonical numeric host"], // octal 127.0.0.1 to glibc
    ["rtmp://017.0.0.1/live", "non-canonical numeric host"], // octal 15.0.0.1, not 17.0.0.1
    ["rtmp://10.0.0.01/live", "non-canonical numeric host"],
    ["rtmp://0x7f.1/live", "non-canonical numeric host"],
    ["rtmp://0x7f000001/live", "non-canonical numeric host"],
    ["rtmp://127.1/live", "non-canonical numeric host"],
    ["rtmp://1.2.3/live", "non-canonical numeric host"],
    ["rtmp://93.184.216.34.5/live", "non-canonical numeric host"],
    ["rtmp://rebind.example.test/live", "resolves to a non-public address"],
    ["rtmp://metadata.example.test/live", "resolves to a non-public address"],
    ["rtmp://mixed.example.test/live", "resolves to a non-public address"],
    ["rtmp://v6local.example.test/live", "resolves to a non-public address"],
    ["rtmp://mapped.example.test/live", "resolves to a non-public address"],
    ["rtmp://cgnat.example.test/live", "resolves to a non-public address"],
    ["rtmp://nxdomain.example.test/live", "unresolvable"],
    ["http://live.twitch.example.test/app", "protocol"],
    ["file:///etc/passwd", "protocol"],
    ["rtmp://user:pw@live.twitch.example.test/app", "credentials"],
    ["not a url", "unparseable"],
  ])("refuses %s (%s)", async (url, reason) => {
    expect(await outboundUrlProblem(url, rtmp)).toBe(reason);
  });

  test("special-scheme IPv4 spellings are normalized and refused", async () => {
    expect(await outboundUrlProblem("https://0x7f.0.0.1/", https)).toBe("non-public address");
    expect(await outboundUrlProblem("https://2130706433/", https)).toBe("non-public address");
    expect(await outboundUrlProblem("https://017700000001/", https)).toBe("non-public address");
  });

  test("development allows private targets but still checks the protocol", async () => {
    const dev = { ...rtmp, allowPrivate: true };
    expect(await outboundUrlProblem("rtmp://localhost/live", dev)).toBeNull();
    expect(await outboundUrlProblem("rtmp://10.0.0.1/live", dev)).toBeNull();
    expect(await outboundUrlProblem("http://localhost/live", dev)).toBe("protocol");
  });
});

describe("relayTargetProblem", () => {
  const deps = (allow: boolean) =>
    ({ env: { OUTBOUND_ALLOW_PRIVATE_NETWORKS: allow }, resolveHost: resolve }) as unknown as Deps;

  test("default (strict): https only, public hosts only", async () => {
    expect(await relayTargetProblem(deps(false), "https://relay.example.test")).toBeNull();
    expect(await relayTargetProblem(deps(false), "http://relay.example.test")).toBe("protocol");
    expect(await relayTargetProblem(deps(false), "https://rebind.example.test")).not.toBeNull();
    expect(await relayTargetProblem(deps(false), "https://127.0.0.1:8443")).not.toBeNull();
  });

  test("OUTBOUND_ALLOW_PRIVATE_NETWORKS: http and private hosts allowed", async () => {
    expect(await relayTargetProblem(deps(true), "http://127.0.0.1:8080")).toBeNull();
    expect(await relayTargetProblem(deps(true), "http://localhost:8080")).toBeNull();
    expect(await relayTargetProblem(deps(true), "ftp://localhost")).toBe("protocol");
  });
});

describe("relay health checks connect to the vetted address", () => {
  test("the address checked is the address dialled; a non-public answer is never dialled", async () => {
    const dialled: [string, string | null][] = [];
    let answer = ["93.184.216.34"];
    const deps = {
      env: { OUTBOUND_ALLOW_PRIVATE_NETWORKS: false },
      resolveHost: async () => answer,
      pinnedGet: async (url: URL, address: string | null) => {
        dialled.push([url.toString(), address]);
        return 200;
      },
    } as unknown as Deps;
    expect((await healthCheck(deps, "https://relay.example.test")).ok).toBe(true);
    expect(dialled).toEqual([["https://relay.example.test/healthz", "93.184.216.34"]]);
    answer = ["10.0.0.5"]; // rebinding to an internal address
    expect((await healthCheck(deps, "https://relay.example.test")).ok).toBe(false);
    expect(dialled).toHaveLength(1);
  });

  test("pinnedGet dials the given address and keeps the URL's Host", async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        seen.push(req.headers.get("host") ?? "");
        return new Response("ok", { status: new URL(req.url).pathname === "/healthz" ? 204 : 404 });
      },
    });
    try {
      // The name does not resolve: only the pinned address can reach the server.
      const url = new URL(`http://relay.example.invalid:${server.port}/healthz`);
      expect(await pinnedGet(url, "127.0.0.1", 2000)).toBe(204);
      expect(seen).toEqual([`relay.example.invalid:${server.port}`]);
    } finally {
      await server.stop(true);
    }
  });

  /** A raw TCP server that dribbles `chunks`, one every `everyMs`, to each connection. */
  async function trickler(chunks: string[], everyMs: number) {
    const sockets = new Set<Socket>();
    const server = createServer((sock) => {
      sockets.add(sock);
      sock.on("error", () => {});
      sock.on("close", () => sockets.delete(sock));
      let i = 0;
      const timer = setInterval(() => {
        const c = chunks[i++];
        if (c === undefined || sock.destroyed) return clearInterval(timer);
        sock.write(c);
      }, everyMs);
      sock.on("close", () => clearInterval(timer));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    return {
      port,
      async close() {
        for (const s of sockets) s.destroy();
        await new Promise<void>((r) => server.close(() => r()));
      },
    };
  }

  test("pinnedGet gives up at the total deadline even while bytes keep trickling", async () => {
    // One byte every 40 ms never trips a 300 ms idle timeout; the headers take ~2 s to finish.
    const head = "HTTP/1.1 200 OK\r\nX-Pad: " + "a".repeat(40) + "\r\nContent-Length: 0\r\n\r\n";
    const srv = await trickler(head.split(""), 40);
    try {
      const started = Date.now();
      const url = new URL(`http://relay.example.invalid:${srv.port}/healthz`);
      await expect(pinnedGet(url, "127.0.0.1", 300)).rejects.toThrow(/deadline/);
      const took = Date.now() - started;
      expect(took).toBeGreaterThanOrEqual(250);
      expect(took).toBeLessThan(1000);
    } finally {
      await srv.close();
    }
  });

  test("pinnedGet still answers a server that sends headers in time, then trickles the body", async () => {
    const srv = await trickler(
      ["HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n", ...Array<string>(50).fill("x")],
      40,
    );
    try {
      const url = new URL(`http://relay.example.invalid:${srv.port}/healthz`);
      expect(await pinnedGet(url, "127.0.0.1", 1000)).toBe(204);
    } finally {
      await srv.close();
    }
  });

  test("pinnedGet times out on a silent server", async () => {
    const srv = await trickler([], 1000);
    try {
      const url = new URL(`http://relay.example.invalid:${srv.port}/healthz`);
      await expect(pinnedGet(url, "127.0.0.1", 200)).rejects.toThrow(/timeout|deadline/);
    } finally {
      await srv.close();
    }
  });
});
