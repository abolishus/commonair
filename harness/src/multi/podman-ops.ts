// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Killing and restoring replica containers. `podman kill` is an instance dying without a
 * shutdown (no drain, no final flush); `restoreContainer` brings it back, waits until its
 * health endpoint answers, and then until connections between the stack's containers work
 * again (`settle.ts`), so later scenarios find the stack whole. Modelled on the self-host e2e's
 * `checkRestart` (scripts/selfhost/e2e.ts).
 */
import { type PodmanResult, podman, podmanOk } from "../drill/podman.ts";
import { waitFor } from "../wait.ts";
import { type ReplicaContainer, parseReplicaContainers } from "./replicas.ts";
import { type NetworkProbe, type SettleOptions, waitForNetwork } from "./settle.ts";

export async function listReplicaContainers(prefix: string): Promise<ReplicaContainer[]> {
  return parseReplicaContainers(await psAll(), prefix);
}

async function psAll(): Promise<string> {
  return podmanOk(["ps", "-a", "--format", "{{.Names}}\t{{.State}}"], { timeoutMs: 30_000 });
}

export async function containerRunning(name: string): Promise<boolean> {
  const r = await podman(["inspect", "--format", "{{.State.Running}}", name], { timeoutMs: 30_000 });
  return r.code === 0 && r.stdout.trim() === "true";
}

/** SIGKILL the container; resolves once podman reports it no longer running. Returns when that was. */
export async function killContainer(name: string): Promise<number> {
  await podmanOk(["kill", "--signal", "KILL", name], { timeoutMs: 30_000 });
  const killedAt = Date.now();
  // A restart policy may bring it straight back; "not running at least once" is all we need.
  await waitFor("container stopped", async () => !(await containerRunning(name)) || Date.now() - killedAt > 5_000, {
    timeoutMs: 10_000,
    intervalMs: 100,
  });
  return killedAt;
}

export async function healthy(url: string): Promise<boolean> {
  const res = await fetch(url, { signal: AbortSignal.timeout(3_000) }).catch(() => null);
  return res?.ok === true;
}

/** The podman and HTTP calls `restoreContainer` makes; injected by tests. */
export interface RestoreOps {
  running(name: string): Promise<boolean>;
  start(name: string): Promise<void>;
  healthy(url: string): Promise<boolean>;
}

const realOps: RestoreOps = {
  running: containerRunning,
  async start(name) {
    // Not podmanOk: the restart policy can win the race, and then the health wait decides.
    await podman(["start", name], { timeoutMs: 60_000 });
  },
  healthy,
};

export interface RestoreOptions {
  /** For the container's own health URL (default 120 s). */
  timeoutMs?: number;
  healthIntervalMs?: number;
  /** Then wait for these cross-container probes (`stackProbes`); none means no wait. */
  settle?: { probes: readonly NetworkProbe[] } & SettleOptions;
  ops?: Partial<RestoreOps>;
}

export interface Restored {
  /** From the call until the container's health URL answered. */
  backMs: number;
  /** From then until every settle probe had passed for its stable window. */
  settledMs: number;
}

/**
 * Start the container if it is not running (the restart policy may already have), wait for its
 * health endpoint, then for the network between containers (`opts.settle`). Throws, naming the
 * probe still failing, when either wait runs out.
 */
export async function restoreContainer(name: string, healthUrl: string, opts: RestoreOptions = {}): Promise<Restored> {
  const ops = { ...realOps, ...opts.ops };
  const started = Date.now();
  if (!(await ops.running(name))) await ops.start(name);
  await waitFor(`${name} healthy at ${healthUrl}`, () => ops.healthy(healthUrl), {
    timeoutMs: opts.timeoutMs ?? 120_000,
    intervalMs: opts.healthIntervalMs ?? 500,
    ...(opts.settle?.signal ? { signal: opts.settle.signal } : {}),
  });
  const backMs = Date.now() - started;
  const settledMs = opts.settle ? await waitForNetwork(opts.settle.probes, opts.settle) : 0;
  return { backMs, settledMs };
}

// ---------------------------------------------------------------- cross-container probes

export type Exec = (container: string, argv: readonly string[]) => Promise<PodmanResult>;

/** Each probe's own limit; a hung exec must not hold up the round. */
const PROBE_EXEC_TIMEOUT_MS = 10_000;

const podmanExec: Exec = (container, argv) =>
  podman(["exec", container, ...argv], { timeoutMs: PROBE_EXEC_TIMEOUT_MS });

/**
 * Inside a service container: fetch its own `/readyz` (the image's healthcheck.ts knows the
 * port) and print the status and body, whose `checks` name each dependency as ok or fail.
 */
export function readyzScript(service: string): string {
  return (
    `const {healthUrl}=await import("/opt/commonair/healthcheck.ts");` +
    `const r=await fetch(healthUrl(${JSON.stringify(service)},process.env),{signal:AbortSignal.timeout(4000)}).catch(()=>null);` +
    `console.log(r?r.status+" "+(await r.text()):"unanswered");process.exit(r?.ok?0:1)`
  );
}

/** Inside a service container: open a TCP connection to its SMTP_HOST:SMTP_PORT (Mailpit). */
export const SMTP_CONNECT_SCRIPT =
  `const s=require("node:net").connect(Number(process.env.SMTP_PORT),process.env.SMTP_HOST);` +
  `const t=setTimeout(()=>{console.log("connect timed out after 3000 ms");process.exit(1)},3000);` +
  `s.on("connect",()=>{clearTimeout(t);s.destroy();process.exit(0)});` +
  `s.on("error",(e)=>{console.log(e.code||e.message);process.exit(1)})`;

function execProbe(name: string, container: string, argv: readonly string[], exec: Exec): NetworkProbe {
  return {
    name,
    async check() {
      const r = await exec(container, argv);
      if (r.code === 0) return null;
      const said = (r.stdout.trim() || r.stderr.trim()).split("\n").slice(-2).join(" | ").slice(0, 300);
      return `exit ${r.code}${said ? `: ${said}` : ""}`;
    },
  };
}

/** The container's own `/readyz`, asked from inside it: its connections to its dependencies. */
export function readinessProbe(container: string, service: string, exec: Exec = podmanExec): NetworkProbe {
  return execProbe(`${container} /readyz`, container, ["bun", "-e", readyzScript(service)], exec);
}

/** A TCP connect from the container to its SMTP host: the link a signup's verification mail takes. */
export function smtpProbe(container: string, exec: Exec = podmanExec): NetworkProbe {
  return execProbe(`${container} → SMTP`, container, ["bun", "-e", SMTP_CONNECT_SCRIPT], exec);
}

/** Compose services the settle probes look for, besides the restored replicas. */
const PROBED_SERVICES = ["api", "media"] as const;

/**
 * The settle probes, from `podman ps -a` output: the API's readiness (Postgres, Valkey) and its
 * SMTP connection, media's readiness (MediaMTX, Postgres, Valkey, S3) when media runs, and the
 * readiness of each container in `restored` (compose service names such as `chat-2`), running
 * or not: the list is made before the restore, and a replica that stays down must fail the wait.
 * Pure apart from what the probes run.
 */
export function stackProbes(
  psOutput: string,
  prefix: string,
  restored: readonly string[] = [],
  exec: Exec = podmanExec,
): NetworkProbe[] {
  const services = [...new Set([...PROBED_SERVICES, ...restored])];
  const probed = parseReplicaContainers(psOutput, prefix, services)
    .filter((c) => c.running || restored.includes(c.service))
    .sort((a, b) => a.name.localeCompare(b.name));
  const probes: NetworkProbe[] = [];
  const seen = new Set<string>();
  for (const c of probed) {
    if (seen.has(c.service)) continue;
    seen.add(c.service);
    // `chat-2` runs the chat image: healthcheck.ts knows the port by the image's service.
    const service = c.service.replace(/-\d+$/, "");
    probes.push(readinessProbe(c.name, service, exec));
    if (c.service === "api") probes.push(smtpProbe(c.name, exec));
  }
  return probes;
}

/** `stackProbes` for the stack as podman lists it now. */
export async function listStackProbes(prefix: string, restored: readonly string[] = []): Promise<NetworkProbe[]> {
  return stackProbes(await psAll(), prefix, restored);
}
