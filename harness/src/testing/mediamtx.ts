// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Throwaway MediaMTX container for driver integration tests and local experiments: permissive
 * auth (anyone may publish and read), every service on a random host port, unique container
 * name, removed on `stop()`. Never touches the shared stack's containers.
 */
import { createSocket } from "node:dgram";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "../wait.ts";

export const MEDIAMTX_IMAGE = "docker.io/bluenviron/mediamtx:1.21.2";

export interface MediaMtxInstance {
  name: string;
  rtmpUrl: string;
  rtspUrl: string;
  hlsUrl: string;
  whipBaseUrl: string;
  apiUrl: string;
  /** HLS multivariant playlist URL for a path, e.g. `live/test`. */
  hlsPlaylist(path: string): string;
  /** WHIP endpoint for a path. */
  whipEndpoint(path: string): string;
  /** Resolves once MediaMTX reports the path ready (a publisher is connected). */
  waitForPath(path: string, timeoutMs?: number): Promise<void>;
  logs(): Promise<string>;
  stop(): Promise<void>;
}

export interface MediaMtxOptions {
  /** `lowLatency` (default, matches production) or `mpegts`/`fmp4`. */
  hlsVariant?: "lowLatency" | "fmp4" | "mpegts";
  hlsSegmentDuration?: string;
  hlsPartDuration?: string;
  image?: string;
}

/** Permissive MediaMTX configuration. Exported for unit tests. */
export function mediamtxConfig(opts: MediaMtxOptions & { webrtcUdpPort: number }): string {
  return [
    "logLevel: info",
    "api: yes",
    "apiAddress: :9997",
    "rtmp: yes",
    "rtmpAddress: :1935",
    "rtsp: yes",
    "rtspAddress: :8554",
    "rtspTransports: [tcp]",
    "hls: yes",
    "hlsAddress: :8888",
    "hlsAllowOrigins: ['*']",
    `hlsVariant: ${opts.hlsVariant ?? "lowLatency"}`,
    `hlsSegmentDuration: ${opts.hlsSegmentDuration ?? "1s"}`,
    `hlsPartDuration: ${opts.hlsPartDuration ?? "200ms"}`,
    "hlsAlwaysRemux: yes",
    "webrtc: yes",
    "webrtcAddress: :8889",
    "webrtcAllowOrigins: ['*']",
    `webrtcLocalUDPAddress: :${opts.webrtcUdpPort}`,
    "webrtcLocalTCPAddress: ''",
    // The container's own interface addresses are unreachable from the host; advertise loopback.
    "webrtcIPsFromInterfaces: no",
    "webrtcAdditionalHosts: [127.0.0.1]",
    "srt: no",
    "authMethod: internal",
    "authInternalUsers:",
    "  - user: any",
    "    pass:",
    "    ips: []",
    "    permissions:",
    "      - action: publish",
    "      - action: read",
    "      - action: playback",
    "      - action: api",
    "      - action: metrics",
    "paths:",
    "  all_others:",
    "",
  ].join("\n");
}

async function freeUdpPort(): Promise<number> {
  const socket = createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => resolve());
  });
  const { port } = socket.address();
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
}

async function run(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** True when podman can run containers here. */
export async function podmanAvailable(): Promise<boolean> {
  try {
    return (await run(["podman", "info", "--format", "{{.Host.Arch}}"])).code === 0;
  } catch {
    return false;
  }
}

export async function startMediaMtx(opts: MediaMtxOptions = {}): Promise<MediaMtxInstance> {
  const name = `harness-mediamtx-${crypto.randomUUID().slice(0, 8)}`;
  const udp = await freeUdpPort();
  // Under podman machine (macOS) only $HOME, /private and /var/folders are shared with the VM;
  // tmpdir() is under one of them.
  const dir = mkdtempSync(join(tmpdir(), "harness-mediamtx-"));
  const configPath = join(dir, "mediamtx.yml");
  writeFileSync(configPath, mediamtxConfig({ ...opts, webrtcUdpPort: udp }));
  const started = await run([
    "podman",
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-v",
    `${configPath}:/mediamtx.yml:ro`,
    "-p",
    "127.0.0.1::1935",
    "-p",
    "127.0.0.1::8554",
    "-p",
    "127.0.0.1::8888",
    "-p",
    "127.0.0.1::8889",
    "-p",
    "127.0.0.1::9997",
    "-p",
    `127.0.0.1:${udp}:${udp}/udp`,
    opts.image ?? MEDIAMTX_IMAGE,
  ]);
  if (started.code !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`podman run failed: ${started.stderr.trim()}`);
  }

  const stop = async () => {
    await run(["podman", "rm", "-f", "-t", "2", name]);
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    const hostPort = async (containerPort: number): Promise<number> => {
      const out = await run(["podman", "port", name, `${containerPort}/tcp`]);
      const match = /:(\d+)\s*$/m.exec(out.stdout.trim());
      if (out.code !== 0 || !match?.[1]) throw new Error(`no host port for ${containerPort}: ${out.stderr}`);
      return Number(match[1]);
    };
    const [rtmp, rtsp, hls, webrtc, api] = await Promise.all([1935, 8554, 8888, 8889, 9997].map(hostPort));
    const apiUrl = `http://127.0.0.1:${api}`;
    await waitFor(
      "mediamtx api",
      async () => {
        const res = await fetch(`${apiUrl}/v3/paths/list`).catch(() => null);
        return res?.ok === true;
      },
      { timeoutMs: 20_000, intervalMs: 200 },
    );
    const hlsUrl = `http://127.0.0.1:${hls}`;
    const whipBaseUrl = `http://127.0.0.1:${webrtc}`;
    return {
      name,
      rtmpUrl: `rtmp://127.0.0.1:${rtmp}`,
      rtspUrl: `rtsp://127.0.0.1:${rtsp}`,
      hlsUrl,
      whipBaseUrl,
      apiUrl,
      hlsPlaylist: (path) => `${hlsUrl}/${path}/index.m3u8`,
      whipEndpoint: (path) => `${whipBaseUrl}/${path}/whip`,
      async waitForPath(path, timeoutMs = 20_000) {
        await waitFor(
          `mediamtx path ${path} ready`,
          async () => {
            const res = await fetch(`${apiUrl}/v3/paths/get/${path}`).catch(() => null);
            if (!res?.ok) return false;
            const body = (await res.json()) as { ready?: boolean };
            return body.ready === true;
          },
          { timeoutMs, intervalMs: 250 },
        );
      },
      logs: async () => {
        const out = await run(["podman", "logs", name]);
        return out.stdout + out.stderr;
      },
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
