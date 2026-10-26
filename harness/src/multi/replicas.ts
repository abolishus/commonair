// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The second instance of each app service in `harness/compose.multi-instance.yaml` (profile
 * `multi`): where the harness reaches it from the host, and which container is which. Pure; the
 * podman calls live in `podman-ops.ts`.
 */
import { serviceOfContainer } from "../safety.ts";

export const REPLICATED = ["api", "chat", "worker", "origin"] as const;
export type ReplicatedService = (typeof REPLICATED)[number];

export interface ReplicaSpec {
  service: ReplicatedService;
  /** Compose service name of the second instance. */
  replica: `${ReplicatedService}-2`;
  /** Host port variable in the override and its default. */
  portVar: string;
  defaultPort: number;
}

/** Must match the override's `ports:` (a unit test reads the file). */
export const REPLICAS: readonly ReplicaSpec[] = [
  { service: "api", replica: "api-2", portVar: "API_2_PORT", defaultPort: 3101 },
  { service: "chat", replica: "chat-2", portVar: "CHAT_2_PORT", defaultPort: 3102 },
  { service: "origin", replica: "origin-2", portVar: "ORIGIN_2_PORT", defaultPort: 3103 },
  { service: "worker", replica: "worker-2", portVar: "WORKER_2_PORT", defaultPort: 3105 },
];

/** Every compose service the scenario looks for: the originals and their replicas. */
export const MULTI_SERVICES: readonly string[] = REPLICAS.flatMap((r) => [r.service, r.replica]);

export interface ReplicaUrls {
  api2: string;
  /** Chat replica base (`ws://host:port`); the path comes from the API's chat URL. */
  chat2: string;
  chat2Health: string;
  worker2Health: string;
  origin2: string;
  /** Valkey as the host sees it (the bus, BullMQ state and MONITOR). */
  valkey: string;
}

/**
 * Replica URLs from the environment: an explicit `HARNESS_*_2_URL` wins, else the host port the
 * override publishes (`*_2_PORT`, as compose reads it from the repo `.env`), else its default.
 */
export function replicaUrls(source: Record<string, string | undefined>): ReplicaUrls {
  const port = (spec: ReplicaSpec) => source[spec.portVar]?.trim() || String(spec.defaultPort);
  const byService = (s: ReplicatedService) => REPLICAS.find((r) => r.service === s) as ReplicaSpec;
  const pick = (name: string, fallback: string) => source[name]?.trim() || fallback;
  const api2 = pick("HARNESS_API_2_URL", `http://localhost:${port(byService("api"))}`);
  const chat2 = pick("HARNESS_CHAT_2_URL", `ws://localhost:${port(byService("chat"))}`);
  const chatHttp = new URL(chat2);
  chatHttp.protocol = chatHttp.protocol === "wss:" ? "https:" : "http:";
  return {
    api2: api2.replace(/\/+$/, ""),
    chat2: chat2.replace(/\/+$/, ""),
    chat2Health: pick("HARNESS_CHAT_2_HEALTH_URL", `${chatHttp.origin}/healthz`),
    worker2Health: pick("HARNESS_WORKER_2_HEALTH_URL", `http://localhost:${port(byService("worker"))}/healthz`),
    origin2: pick("HARNESS_ORIGIN_2_URL", `http://localhost:${port(byService("origin"))}`).replace(/\/+$/, ""),
    valkey: valkeyUrl(source),
  };
}

/**
 * Valkey for the host: `HARNESS_VALKEY_URL`, else the repo `.env`'s `VALKEY_URL` (init-env puts
 * the password in it), with `VALKEY_PASSWORD` added when the URL carries none.
 */
export function valkeyUrl(source: Record<string, string | undefined>): string {
  const raw = source.HARNESS_VALKEY_URL?.trim() || source.VALKEY_URL?.trim() || "redis://localhost:6379";
  const url = new URL(raw);
  const password = source.VALKEY_PASSWORD?.trim();
  if (!url.password && password && !source.HARNESS_VALKEY_URL?.trim()) url.password = password;
  return url.toString();
}

/**
 * The URL a client connects to on the chat replica: the API's chat URL (its path and query,
 * e.g. `/ws?token=…`) with the replica's scheme, host and port.
 */
export function chatUrlOn(base: string, chatUrl: string): string {
  const target = new URL(chatUrl);
  const b = new URL(base);
  target.protocol = b.protocol;
  target.hostname = b.hostname;
  // Assigning `host` without a port would keep the old one; "" means the scheme's default.
  target.port = b.port;
  return target.toString();
}

export interface ReplicaContainer {
  service: string;
  name: string;
  running: boolean;
}

/**
 * Containers of the replicated services from `podman ps -a --format '{{.Names}}\t{{.State}}'`,
 * named as compose names them (`commonair_chat-2_1`, `commonair-chat-2-1`; see `safety.ts`).
 */
export function parseReplicaContainers(stdout: string, prefix: string): ReplicaContainer[] {
  const out: ReplicaContainer[] = [];
  for (const line of stdout.split("\n")) {
    const [name = "", state = ""] = line.trim().split(/\t|\s+/);
    if (!name) continue;
    const service = serviceOfContainer(name, prefix, MULTI_SERVICES);
    if (service) out.push({ service, name, running: state.toLowerCase() === "running" });
  }
  return out;
}

/** The replicas that are not running (missing or stopped), by compose service name. */
export function missingReplicas(containers: readonly ReplicaContainer[]): string[] {
  return REPLICAS.filter((r) => !containers.some((c) => c.service === r.replica && c.running)).map((r) => r.replica);
}

/** The one container of a service (the first, when compose numbered several). */
export function containerOf(containers: readonly ReplicaContainer[], service: string): ReplicaContainer | null {
  return containers.filter((c) => c.service === service).sort((a, b) => a.name.localeCompare(b.name))[0] ?? null;
}
