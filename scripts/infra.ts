// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Local infrastructure helper around `podman compose`.
 *
 *   bun scripts/infra.ts test   start the data services integration tests need, wait for health
 *   bun scripts/infra.ts down   stop everything (volumes kept)
 *   bun scripts/infra.ts reset  stop everything and delete volumes
 */
export const TEST_SERVICES = ["postgres", "valkey", "mailpit", "garage", "garage-init", "migrate"];
/** Long-running services that report health. */
export const HEALTHY_SERVICES = ["postgres", "valkey", "mailpit", "garage"];
/** One-shot jobs that must exit 0. */
export const ONE_SHOT_SERVICES = ["garage-init", "migrate"];
/** Locally built images the test subset needs (`migrate` shares the tools image). */
const BUILD_SERVICES = ["postgres", "garage-init"];

function compose(args: string[]): void {
  const proc = Bun.spawnSync(["podman", "compose", ...args], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (proc.exitCode !== 0) throw new Error(`podman compose ${args.join(" ")} failed (${proc.exitCode})`);
}

function health(service: string): string {
  const id = Bun.spawnSync([
    "podman",
    "ps",
    "-q",
    "--filter",
    "label=com.docker.compose.project=commonair",
    "--filter",
    `label=com.docker.compose.service=${service}`,
  ])
    .stdout.toString()
    .trim()
    .split("\n")[0];
  if (!id) return "missing";
  const out = Bun.spawnSync(["podman", "inspect", "-f", "{{.State.Health.Status}}", id]);
  return out.stdout.toString().trim() || "unknown";
}

function containerId(service: string): string | undefined {
  return Bun.spawnSync([
    "podman",
    "ps",
    "-a",
    "-q",
    "--filter",
    "label=com.docker.compose.project=commonair",
    "--filter",
    `label=com.docker.compose.service=${service}`,
  ])
    .stdout.toString()
    .trim()
    .split("\n")[0];
}

/** Wait for one-shot jobs to exit; throws with the job's logs if one exits non-zero. */
export async function waitExited(services: string[], timeoutMs = 300_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(services);
  while (pending.size > 0) {
    for (const s of pending) {
      const id = containerId(s);
      if (!id) continue;
      const out = Bun.spawnSync(["podman", "inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", id]);
      const [status, code] = out.stdout.toString().trim().split(" ");
      if (status !== "exited") continue;
      if (code !== "0") {
        const logs = Bun.spawnSync(["podman", "logs", "--tail", "40", id]);
        throw new Error(`${s} exited ${code}:\n${logs.stdout.toString()}${logs.stderr.toString()}`);
      }
      pending.delete(s);
    }
    if (pending.size === 0) return;
    if (Date.now() > deadline) throw new Error(`one-shot jobs did not finish: ${[...pending].join(", ")}`);
    await Bun.sleep(1000);
  }
}

export async function waitHealthy(services: string[], timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const states = services.map((s) => [s, health(s)] as const);
    if (states.every(([, h]) => h === "healthy")) return;
    if (Date.now() > deadline)
      throw new Error(`services not healthy: ${states.map(([s, h]) => `${s}=${h}`).join(", ")}`);
    await Bun.sleep(1000);
  }
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === "test") {
    compose(["build", ...BUILD_SERVICES]);
    compose(["up", "-d", ...TEST_SERVICES]);
    await waitHealthy(HEALTHY_SERVICES);
    await waitExited(ONE_SHOT_SERVICES);
    console.log(`infra: ${TEST_SERVICES.join(", ")} healthy`);
  } else if (cmd === "down") {
    compose(["down"]);
  } else if (cmd === "reset") {
    compose(["down", "-v"]);
  } else {
    console.error("usage: bun scripts/infra.ts test|down|reset");
    process.exit(2);
  }
}
