#!/usr/bin/env bun
// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `bun run --filter @commonair/db demo:seed [-- --reset]`
 * `bun run --filter @commonair/db demo:clear [-- --yes]`
 *
 * Connects with DATABASE_URL. The least-privilege app role is enough (both commands only touch
 * tables it may write); the owner URL works too. Output goes to stdout; nothing is logged.
 */
import { createDb } from "../client.ts";
import { type ClearReport, clearDemo } from "./clear.ts";
import { generatePassword, passwordProblem } from "./password.ts";
import { seedDemo } from "./seed.ts";

export type DemoCommand = { kind: "seed"; reset: boolean } | { kind: "clear"; execute: boolean } | { kind: "help" };

export const DEMO_USAGE = `Usage:
  bun packages/db/src/demo/cli.ts seed [--reset]   insert demo data (--reset: clear existing demo data first)
  bun packages/db/src/demo/cli.ts clear [--yes]    delete demo data (dry run without --yes)

Environment:
  DATABASE_URL         target database (required)
  DEMO_SEED_PASSWORD   shared password for every demo account (default: generated, printed once)
`;

export class DemoUsageError extends Error {}

export function parseDemoArgs(argv: readonly string[]): DemoCommand {
  const [command, ...flags] = argv;
  const allow = (allowed: string[]) => {
    for (const f of flags) if (!allowed.includes(f)) throw new DemoUsageError(`unknown option ${f} for ${command}`);
  };
  switch (command) {
    case "seed":
      allow(["--reset"]);
      return { kind: "seed", reset: flags.includes("--reset") };
    case "clear":
      allow(["--yes"]);
      return { kind: "clear", execute: flags.includes("--yes") };
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return { kind: "help" };
    default:
      throw new DemoUsageError(`unknown command "${command}"`);
  }
}

/** `host:port/database` of a connection URL, without credentials. */
export function describeTarget(url: string): string {
  const u = new URL(url);
  return `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
}

export function formatClearReport(report: ClearReport, executed: boolean): string {
  const width = Math.max(...report.steps.map((s) => s.table.length));
  const lines = report.steps.map((s) => `  ${s.table.padEnd(width)}  ${String(s.rows).padStart(6)}  ${s.what}`);
  const total = report.steps.reduce((n, s) => n + s.rows, 0);
  return [
    `${report.anchoredUsers} demo user(s) match both anchors.`,
    ...lines,
    executed
      ? `Deleted ${total} row(s). Audit log rows stay (ids only).`
      : `Dry run: would delete ${total} row(s). Re-run with --yes to delete.`,
  ].join("\n");
}

const out = (s: string) => process.stdout.write(`${s}\n`);

async function main(argv: string[]): Promise<number> {
  let command: DemoCommand;
  try {
    command = parseDemoArgs(argv);
  } catch (err) {
    if (!(err instanceof DemoUsageError)) throw err;
    console.error(`${err.message}\n\n${DEMO_USAGE}`);
    return 2;
  }
  if (command.kind === "help") {
    out(DEMO_USAGE);
    return 0;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    return 2;
  }
  out(`Target database: ${describeTarget(url)}`);
  const handle = createDb({ url, max: 1, applicationName: "commonair-demo" });
  try {
    if (command.kind === "clear") {
      const report = await clearDemo(handle.db, { execute: command.execute });
      out(formatClearReport(report, command.execute));
      return 0;
    }
    const given = process.env.DEMO_SEED_PASSWORD;
    const problem = given ? passwordProblem(given) : null;
    if (problem) {
      console.error(`DEMO_SEED_PASSWORD ${problem}`);
      return 2;
    }
    const password = given || generatePassword();
    const result = await seedDemo(handle.db, { password, reset: command.reset });
    if (result.status === "exists") {
      out(`${result.existing} demo user(s) already exist; nothing changed. Use --reset to clear and re-seed.`);
      return 0;
    }
    if (result.cleared) out(formatClearReport(result.cleared, true));
    const s = result.summary;
    out(
      `Seeded ${s.accounts.length} accounts, ${s.channels} channels, ${s.follows} follows, ${s.chatMessages} chat messages, ` +
        `${s.broadcasts} past broadcasts, ${s.bans} bans/timeouts, ${s.streamKeys} stream keys.`,
    );
    out("Accounts (sign in with the email; `demo_` usernames are reserved, so username sign-in is refused):");
    for (const a of s.accounts)
      out(
        `  ${a.role.padEnd(8)} ${a.username.padEnd(16)} ${a.role === "bot" ? "(bot: no password sign-in)" : a.email}`,
      );
    out(given ? "Password: the value of DEMO_SEED_PASSWORD" : `Password for every account: ${password}`);
    return 0;
  } finally {
    await handle.close();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
