#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Harness CLI: `run <scenario...>`, `list`, `load`. Exit code 0 only when every scenario passed
 * (or was skipped by the profile); reports land in `harness/reports/`.
 */
import { createLogger } from "@commonair/observability";
import { type Command, USAGE, UsageError, parseArgs } from "./args.ts";
import { loadHarnessEnv } from "./env.ts";
import { type LoadOptions, runLoad } from "./load.ts";
import { stopAll } from "./process.ts";
import { FULL_SHARDS, loadRegistry, onlySelected } from "./registry.ts";
import { DEFAULT_REPORT_DIR, formatHuman, writeReport } from "./report.ts";
import { formatSkipTable, newRunId, runScenarios } from "./runner.ts";
import { defineScenario } from "./scenario.ts";

async function main(argv: string[]): Promise<number> {
  let command: Command;
  try {
    command = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n\n${USAGE}`);
      return 2;
    }
    throw err;
  }
  if (command.kind === "help") {
    console.log(USAGE);
    return 0;
  }

  const registry = await loadRegistry();
  if (command.kind === "list") {
    if (command.json) {
      console.log(
        JSON.stringify(
          registry.all.map((s) => ({
            name: s.name,
            description: s.description,
            needs: s.needs,
            inFull: s.inFull !== false,
          })),
          null,
          2,
        ),
      );
    } else {
      const width = Math.max(4, ...registry.all.map((s) => s.name.length));
      console.log(`${"full".padEnd(width)}  every scenario below marked *`);
      console.log(`${"full:<shard>".padEnd(width)}  one part of full: ${Object.keys(FULL_SHARDS).join(", ")}`);
      for (const s of registry.all) {
        console.log(
          `${s.name.padEnd(width)}${s.inFull === false ? " " : "*"} ${s.description}  [${s.needs.join(", ")}]`,
        );
      }
    }
    return 0;
  }

  const env = loadHarnessEnv({ ...process.env, ...(command.player ? { HARNESS_PLAYER: command.player } : {}) });
  const runId = newRunId();
  const log = createLogger({ service: "harness", level: env.LOG_LEVEL, base: { run: runId } });
  const controller = new AbortController();
  // First Ctrl-C aborts the run (cleanups and the report still happen); a second one exits now.
  const onSignal = () => {
    log.warn("interrupted: stopping scenarios, press Ctrl-C again to exit immediately");
    controller.abort(new Error("interrupted"));
    process.once("SIGINT", () => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const selectRun = (names: string[]) => {
    const { run, dropped } = onlySelected(names, registry.resolve(names), registry.all, process.env.HARNESS_ONLY);
    if (dropped.length > 0)
      log.info("HARNESS_ONLY: scenarios this change cannot affect are skipped", {
        run: run.map((s) => s.name),
        skipped: dropped,
      });
    return run;
  };
  const scenarios =
    command.kind === "run"
      ? selectRun(command.scenarios)
      : [
          defineScenario({
            name: "load",
            description: `load test: ${command.streamers} streamers × ${command.viewers} viewers`,
            needs: [
              "api",
              "mail",
              "media",
              "origin",
              "ffmpeg",
              "browser",
              ...(command.protocol === "whip" ? (["whip"] as const) : []),
            ],
            timeoutMs: command.durationMs + 15 * 60_000,
            run: async (ctx) => {
              const opts: LoadOptions = {
                streamers: command.streamers,
                viewers: command.viewers,
                durationMs: command.durationMs,
                browserViewers: command.browserViewers,
                protocol: command.protocol,
              };
              const result = await runLoad(ctx, opts);
              ctx.check("every viewer started playback", result.all.started === result.all.viewers, {
                started: result.all.started,
                viewers: result.all.viewers,
              });
            },
          }),
        ];

  const report = await runScenarios(scenarios, {
    command: command.kind,
    profile: command.profile,
    env,
    log,
    params: command.params,
    skipUnavailable: command.kind === "run" ? command.skipUnavailable : false,
    runId,
    signal: controller.signal,
  });
  await stopAll();
  const paths = writeReport(report, { dir: env.HARNESS_REPORT_DIR ?? DEFAULT_REPORT_DIR, jsonPath: command.report });
  const skips = formatSkipTable(report.scenarios);
  console.log(`\n${formatHuman(report)}${skips ? `\n\n${skips}` : ""}\n\nreport: ${paths.json}\n        ${paths.text}`);
  return report.ok ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : err);
      void stopAll().finally(() => process.exit(1));
    },
  );
}

export { main };
