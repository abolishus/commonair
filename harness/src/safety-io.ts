// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `trust-safety` scenario's side effects outside the API client: the test-hook routes, the
 * synthetic-fixture publisher, first-frame extraction, presigned uploads, the media bucket
 * listing and the services' logs (`podman logs`).
 *
 * Safety: only the synthetic fixtures in `packages/moderation/fixtures/`, a run-unique ffmpeg
 * pattern and frames of this run's own clips of that pattern ever pass through here. Image bytes
 * are never logged or written to the report.
 */
import type { Logger } from "@commonair/observability";
import {
  INTERNAL_ROUTES,
  INTERNAL_SECRET_HEADER,
  type ModerationScores,
  NciiClockResult,
} from "@commonair/contracts/internal";
import { readFileSync } from "node:fs";
import { S3Client } from "bun";
import type { HarnessEnv } from "./env.ts";
import { ProgressParser } from "./ffmpeg.ts";
import { type Supervised, spawnSupervised } from "./process.ts";
import {
  type FixturePublishOptions,
  LOG_SERVICES,
  buildFixturePublishArgs,
  firstFrameArgs,
  serviceOfContainer,
} from "./safety.ts";
import { withTimeout } from "./wait.ts";

export const ffmpegFailure = (stage: "publish" | "frame") =>
  new Error(stage === "publish" ? "fixture_publish_failed" : "fixture_frame_extraction_failed");

// ---------------------------------------------------------------- test hooks

/** The instance's INTERNAL_API_SECRET (harness override first, then the repo `.env` Bun loaded). */
export function internalSecret(
  harness: Pick<HarnessEnv, "HARNESS_INTERNAL_API_SECRET">,
  instance: Record<string, string | undefined> = process.env,
): string | undefined {
  const v = harness.HARNESS_INTERNAL_API_SECRET?.trim() || instance.INTERNAL_API_SECRET?.trim();
  return v || undefined;
}

export class TestHooksOff extends Error {
  constructor(route: string) {
    super(
      `${route} answered 404: the API's test hooks are off (apply harness/compose.trust-safety.yaml, MODERATION_TEST_HOOKS=true)`,
    );
    this.name = "TestHooksOff";
  }
}

/** `PUT /internal/moderation/script` and `POST /internal/moderation/ncii-tick`, straight to the API. */
export class ModerationHooks {
  constructor(
    private readonly apiUrl: string,
    private readonly secret: string,
    private readonly signal?: AbortSignal,
  ) {}

  private async call(method: "PUT" | "POST", route: string, body: unknown, timeoutMs: number): Promise<Response> {
    const res = await fetch(new URL(route, this.apiUrl), {
      method,
      headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: this.secret },
      body: JSON.stringify(body),
      signal: this.signal
        ? AbortSignal.any([this.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) throw new TestHooksOff(route);
    if (!res.ok) throw new Error(`${route} answered HTTP ${res.status}`);
    return res;
  }

  /** Scores the scripted classifier returns for every frame of the channel from now on. */
  async setScores(channelId: string, scores: ModerationScores): Promise<void> {
    await this.call("PUT", INTERNAL_ROUTES.moderationScript, { channelId, scores }, 10_000);
  }

  /** Run the NCII clock as of `asOf` and return what it did (the API waits up to 30 s). */
  async nciiTick(asOf: string): Promise<NciiClockResult> {
    const res = await this.call("POST", INTERNAL_ROUTES.nciiTick, { asOf }, 45_000);
    return NciiClockResult.parse(await res.json());
  }
}

// ---------------------------------------------------------------- publisher

/** One ffmpeg publishing a synthetic fixture or pattern. Supervised; `stop()` always ends it. */
export class FixturePublisher {
  firstFrameAt: number | null = null;
  private proc: Supervised | null = null;

  constructor(
    readonly name: string,
    private readonly opts: FixturePublishOptions,
    private readonly log?: Logger,
  ) {}

  get running(): boolean {
    return this.proc?.running === true;
  }

  get exited(): Promise<number> | null {
    return this.proc?.exited ?? null;
  }

  stderr(): string[] {
    return this.proc?.stderr() ?? [];
  }

  /** Spawn ffmpeg; returns at once (use `waitFirstFrame` or `exited`). */
  spawn(): void {
    if (this.proc?.running) throw new Error(`${this.name} already running`);
    this.firstFrameAt = null;
    const parser = new ProgressParser();
    this.proc = spawnSupervised(["ffmpeg", ...buildFixturePublishArgs(this.opts)], {
      name: this.name,
      onStdoutLine: (line) => {
        const p = parser.push(line);
        if (p && p.frame > 0 && this.firstFrameAt === null) this.firstFrameAt = Date.now();
      },
    });
    this.log?.info("fixture publisher started", { publisher: this.name });
  }

  /** Spawn and wait until ffmpeg has encoded and sent its first frames; throws if it exits first. */
  async start(timeoutMs = 20_000): Promise<number> {
    this.spawn();
    const proc = this.proc as Supervised;
    const started = Date.now();
    while (this.firstFrameAt === null) {
      if (!proc.running) throw ffmpegFailure("publish");
      if (Date.now() - started > timeoutMs) {
        await proc.stop(500);
        throw new Error(`${this.name}: no frames within ${timeoutMs} ms`);
      }
      await Bun.sleep(50);
    }
    return this.firstFrameAt;
  }

  async stop(graceMs = 2_000): Promise<number | null> {
    if (!this.proc) return null;
    return this.proc.stop(graceMs);
  }
}

// ---------------------------------------------------------------- frames and uploads

/** The first video frame of `url` as PNG bytes (ffmpeg; kept in memory, never written to disk). */
export async function extractFirstFrame(url: string, timeoutMs = 30_000): Promise<Uint8Array> {
  const proc = Bun.spawn(["ffmpeg", ...firstFrameArgs(url)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  try {
    const [bytes, code] = await withTimeout(
      "first frame extraction",
      Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]),
      timeoutMs,
    );
    if (code !== 0 || bytes.byteLength === 0) {
      throw ffmpegFailure("frame");
    }
    return new Uint8Array(bytes);
  } finally {
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }
}

/** PUT bytes to a presigned upload URL with the headers the API asked for. */
export async function putPresigned(
  uploadUrl: string,
  headers: Record<string, string>,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(uploadUrl, { method: "PUT", headers, body: new Blob([new Uint8Array(bytes)]), signal });
  if (!res.ok) throw new Error(`presigned upload answered HTTP ${res.status}`);
}

export function readFixture(path: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(path));
  } catch {
    throw new Error(
      `synthetic fixture ${path} is missing: generate it with \`bun packages/moderation/fixtures/generate.ts\` (E4c unit A)`,
    );
  }
}

// ---------------------------------------------------------------- media bucket

export interface MediaBucketConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/** The media bucket's credentials from the repo `.env` (Bun loads it), or null when unset. */
export function mediaBucketConfig(env: HarnessEnv): MediaBucketConfig | null {
  const { S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
  if (!S3_ENDPOINT || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) return null;
  return {
    endpoint: S3_ENDPOINT,
    region: env.S3_REGION ?? "garage",
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
    bucket: env.S3_BUCKET_MEDIA ?? "commonair-media",
  };
}

function s3(config: MediaBucketConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    bucket: config.bucket,
    virtualHostedStyle: false,
  });
}

/** Keys under `prefix` in the media bucket (at most `max`). */
export async function listMediaKeys(config: MediaBucketConfig, prefix: string, max = 100): Promise<string[]> {
  const res = await s3(config).list({ prefix, maxKeys: max });
  return (res.contents ?? []).map((o) => o.key);
}

export async function mediaKeyExists(config: MediaBucketConfig, key: string): Promise<boolean> {
  return s3(config).file(key).exists();
}

// ---------------------------------------------------------------- service logs

async function run(cmd: string[], timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  try {
    const [stdout, stderr, code] = await withTimeout(
      cmd.slice(0, 2).join(" "),
      Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
      timeoutMs,
    );
    return { code, stdout, stderr };
  } finally {
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }
}

/** The compose containers of the services whose logs are scanned: `{ service, name }`. */
export async function serviceContainers(
  prefix: string,
  services: readonly string[] = LOG_SERVICES,
): Promise<{ service: string; name: string }[]> {
  const { code, stdout, stderr } = await run(["podman", "ps", "--format", "{{.Names}}"]);
  if (code !== 0) throw new Error(`podman ps failed: ${stderr.trim().slice(0, 200)}`);
  return stdout
    .split("\n")
    .map((name) => ({ name: name.trim(), service: serviceOfContainer(name, prefix, services) }))
    .filter((c): c is { name: string; service: string } => c.service !== null);
}

/** One container's stdout and stderr since `since` (podman writes both streams). */
export async function containerLogs(name: string, since: Date): Promise<string> {
  const { code, stdout, stderr } = await run(["podman", "logs", "--since", since.toISOString(), name], 60_000);
  if (code !== 0) throw new Error(`podman logs ${name} failed (exit ${code})`);
  return `${stdout}\n${stderr}`;
}
