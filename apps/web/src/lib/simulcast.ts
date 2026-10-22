// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/dashboard` simulcast section logic, pure for unit tests: rows for `SimulcastPanel`, when to
 * poll, the URL checks made before asking the API, and how a refusal is shown. The key never
 * appears here: it goes from the form straight into `stream.simulcast.create`.
 */
import { SIMULCAST_PLATFORMS, SIMULCAST_STATUSES } from "@commonair/contracts/enums";
import type { SimulcastTargetRow } from "@commonair/ui/blocks/studio";
import { t, type MessageKey } from "../i18n/index.ts";
import { errorCode, type Api } from "./api.ts";

export type SimulcastTargetDto = Awaited<ReturnType<Api["stream"]["simulcast"]["list"]>>[number];
export type SimulcastPlatform = (typeof SIMULCAST_PLATFORMS)[number];
export type SimulcastStatus = (typeof SIMULCAST_STATUSES)[number];

/** docs/testing/e6-selectors.md: the status shows `live` within 20 s of going live. */
export const SIMULCAST_POLL_MS = 5_000;

const PLATFORM_KEYS: Record<SimulcastPlatform, MessageKey> = {
  twitch: "simulcast.platform.twitch",
  youtube: "simulcast.platform.youtube",
  custom: "simulcast.platform.custom",
};

const STATUS_KEYS: Record<SimulcastStatus, MessageKey> = {
  idle: "simulcast.status.idle",
  connecting: "simulcast.status.connecting",
  live: "simulcast.status.live",
  error: "simulcast.status.error",
  stopped: "simulcast.status.stopped",
};

export function simulcastPlatformOptions(): { value: SimulcastPlatform; label: string }[] {
  return SIMULCAST_PLATFORMS.map((value) => ({ value, label: t(PLATFORM_KEYS[value]) }));
}

export const isSimulcastPlatform = (value: string): value is SimulcastPlatform =>
  (SIMULCAST_PLATFORMS as readonly string[]).includes(value);

export function simulcastRows(targets: readonly SimulcastTargetDto[]): SimulcastTargetRow[] {
  return targets.map((target) => ({
    id: target.id,
    name: target.name,
    platform: target.platform,
    platformLabel: t(PLATFORM_KEYS[target.platform]),
    rtmpUrl: target.rtmpUrl,
    enabled: target.enabled,
    status: target.status,
    statusLabel: t(STATUS_KEYS[target.status]),
    lastError: target.lastError,
  }));
}

/**
 * Whether a status can still change without the owner doing anything: an enabled target follows
 * the channel going live or offline, and a disabled one that is not idle yet is still winding
 * down. With neither, polling would only repeat the same answer.
 */
export function shouldPollSimulcast(targets: readonly Pick<SimulcastTargetDto, "enabled" | "status">[]): boolean {
  return targets.some((target) => target.enabled || (target.status !== "idle" && target.status !== "stopped"));
}

export type SimulcastUrlProblem = "format" | "credentials";

/**
 * Checks the API would refuse anyway, made first so the owner gets a specific reason (the API
 * answers every network refusal with one generic error on purpose).
 */
export function simulcastUrlProblem(raw: string): SimulcastUrlProblem | null {
  const url = raw.trim();
  if (!/^rtmps?:\/\/[^/\s]/i.test(url)) return "format";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "format";
  }
  if (parsed.username !== "" || parsed.password !== "") return "credentials";
  if (parsed.hostname === "") return "format";
  return null;
}

export interface SimulcastErrorView {
  /** Set as `data-reason` on `simulcast-error`. */
  reason: string;
  message: string;
}

function requirementOf(err: unknown): string | null {
  if (typeof err !== "object" || err === null || !("data" in err)) return null;
  const data = (err as { data?: unknown }).data;
  if (typeof data !== "object" || data === null || !("requirement" in data)) return null;
  const requirement = (data as { requirement?: unknown }).requirement;
  return typeof requirement === "string" ? requirement : null;
}

/**
 * A local URL problem (a `SimulcastUrlProblem`) or the API's refusal, as the inline error. Never
 * the server's own text.
 */
export function simulcastError(problem: unknown): SimulcastErrorView {
  if (problem === "format") return { reason: "format", message: t("simulcast.error.format") };
  if (problem === "credentials") return { reason: "credentials", message: t("simulcast.error.credentials") };
  const code = errorCode(problem);
  const requirement = requirementOf(problem);
  if (requirement === "simulcast_limit") return { reason: requirement, message: t("simulcast.error.limit") };
  if (code === "BAD_REQUEST") return { reason: "url", message: t("simulcast.error.url") };
  if (code === "UNAUTHORIZED") return { reason: "unauthorized", message: t("auth.sessionExpired") };
  return { reason: code ?? "network", message: t("simulcast.error.generic") };
}
