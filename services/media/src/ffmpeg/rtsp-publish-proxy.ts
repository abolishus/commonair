// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A loopback TCP relay in front of MediaMTX's RTSP port for the service's own publishers (the
 * ladder rungs and the AAC copy). It changes nothing but the order of the publisher's first
 * packets (`SrPrimer`), so a `useAbsoluteTimestamp` path has absolute time from the first packet
 * instead of ~5 s later. MediaMTX → publisher bytes pass through unchanged.
 */
import { createServer, connect, type Server, type Socket } from "node:net";
import { SrPrimer } from "./sr-primer.ts";

export interface RtspPublishProxy {
  /** `rtsp://127.0.0.1:<port>`: a base for `internalRtspUrl`. */
  readonly base: string;
  close(): Promise<void>;
}

/** Start the relay to the host and port of `upstreamBase` (an `rtsp://` URL). */
export async function startRtspPublishProxy(upstreamBase: string): Promise<RtspPublishProxy> {
  const up = new URL(upstreamBase);
  if (up.protocol !== "rtsp:") throw new Error("MEDIAMTX_RTSP_URL must be an rtsp:// URL");
  const host = up.hostname.replace(/^\[|\]$/g, "");
  const port = Number(up.port || 554);
  const sockets = new Set<Socket>();

  const server: Server = createServer((client) => {
    const upstream = connect({ host, port });
    sockets.add(client);
    sockets.add(upstream);
    const primer = new SrPrimer();
    // An error on either side ends both; a clean close from the publisher (after TEARDOWN) only
    // ends MediaMTX's side once what was written is flushed.
    const fail = () => {
      client.destroy();
      upstream.destroy();
    };
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    client.on("error", fail).on("close", () => {
      sockets.delete(client);
      upstream.end();
    });
    upstream.on("error", fail).on("close", () => {
      sockets.delete(upstream);
      client.destroy();
    });
    // MediaMTX → publisher: unchanged, with back-pressure.
    upstream.pipe(client);
    client.on("data", (chunk: Buffer) => {
      let full = false;
      for (const part of primer.push(chunk)) if (!upstream.write(part)) full = true;
      if (full) {
        client.pause();
        upstream.once("drain", () => client.resume());
      }
    });
    client.on("end", () => upstream.end());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("rtsp publish relay has no TCP address");
  return {
    base: `rtsp://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
