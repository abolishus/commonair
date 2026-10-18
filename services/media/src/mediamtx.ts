// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Minimal MediaMTX v3 control-API client (1.21.x field names). Authenticates as the internal
 * user with basic auth; MediaMTX forwards that to the API auth hook as action `api`.
 */
import { z } from "zod";
import { MEDIA_INTERNAL_USER } from "@commonair/contracts/internal";

const Source = z.object({ type: z.string(), id: z.string().default("") }).nullable();
export const MtxPath = z.object({
  name: z.string(),
  ready: z.boolean().default(false),
  online: z.boolean().optional(),
  source: Source.default(null),
  tracks: z.array(z.string()).default([]),
  tracks2: z
    .array(
      z.object({
        codec: z.string(),
        codecProps: z.object({ width: z.number().optional(), height: z.number().optional() }).partial().optional(),
      }),
    )
    .optional(),
  inboundBytes: z.number().optional(),
  bytesReceived: z.number().optional(),
  inboundFramesInError: z.number().optional(),
});
export type MtxPath = z.infer<typeof MtxPath>;
const PathList = z.object({ pageCount: z.number().default(1), items: z.array(MtxPath).default([]) });

export class MediaMtxError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MediaMtxError";
  }
}

/** Live means a publisher is connected and the stream is readable. */
export const isLive = (p: MtxPath) => p.ready && p.online !== false;
export const pathBytes = (p: MtxPath) => p.inboundBytes ?? p.bytesReceived ?? 0;

export interface SourceInfo {
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
}

/** Track summary from the API, available immediately (no ffprobe round trip). */
export function sourceInfo(p: MtxPath): SourceInfo {
  const video = p.tracks2?.find((t) => /^(H264|H265|AV1|VP8|VP9|MPEG-4 Video|M-JPEG)$/.test(t.codec));
  const hasVideo = video !== undefined || p.tracks.some((t) => /H26[45]|AV1|VP[89]|Video|JPEG/.test(t));
  const hasAudio = p.tracks.some((t) => /Audio|Opus|AAC|G711|LPCM|AC-3|MPEG-1\/2 Audio/.test(t));
  return { height: video?.codecProps?.height ?? null, hasVideo, hasAudio };
}

/** API path segment for kicking a source, by MediaMTX source type. */
const KICK_ROUTES: Record<string, string> = {
  rtmpConn: "rtmpconns",
  rtmpsConn: "rtmpsconns",
  webRTCSession: "webrtcsessions",
  rtspSession: "rtspsessions",
  rtspsSession: "rtspssessions",
  srtConn: "srtconns",
};

export class MediaMtxClient {
  private readonly auth: string;

  constructor(
    private readonly baseUrl: string,
    secret: string,
    private readonly timeoutMs = 5_000,
  ) {
    this.auth = `Basic ${btoa(`${MEDIA_INTERNAL_USER}:${secret}`)}`;
  }

  private async request(method: "GET" | "POST", path: string): Promise<Response> {
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: { authorization: this.auth },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return res;
  }

  private async json(path: string): Promise<unknown> {
    const res = await this.request("GET", path);
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new MediaMtxError(res.status, `MediaMTX GET ${path}: HTTP ${res.status}`);
    }
    return res.json();
  }

  async listPaths(): Promise<MtxPath[]> {
    const out: MtxPath[] = [];
    for (let page = 0; ; page++) {
      const body = PathList.parse(await this.json(`/v3/paths/list?itemsPerPage=500&page=${page}`));
      out.push(...body.items);
      if (page + 1 >= body.pageCount) return out;
    }
  }

  async getPath(name: string): Promise<MtxPath | null> {
    const body = await this.json(`/v3/paths/get/${name.split("/").map(encodeURIComponent).join("/")}`);
    return body === null ? null : MtxPath.parse(body);
  }

  /** Disconnect whoever publishes `path`. Returns false when nothing was publishing. */
  async kickPublisher(path: string): Promise<boolean> {
    const p = await this.getPath(path);
    if (!p?.source?.id) return false;
    const route = KICK_ROUTES[p.source.type];
    if (!route) throw new MediaMtxError(400, `cannot kick source type ${p.source.type}`);
    const res = await this.request("POST", `/v3/${route}/kick/${encodeURIComponent(p.source.id)}`);
    await res.body?.cancel();
    if (res.status === 404) return false;
    if (!res.ok) throw new MediaMtxError(res.status, `MediaMTX kick ${route}: HTTP ${res.status}`);
    return true;
  }

  /** Readiness: the API answers and accepts our credentials. */
  async check(): Promise<void> {
    await this.json("/v3/paths/list?itemsPerPage=1");
  }
}
