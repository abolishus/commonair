// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Every `selfhost.sh` command in docs/self-hosting/ is one the script accepts (R0-release-prep):
// its subcommand is in main(), and each flag is in that subcommand's parser and in --help.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DOCS = join(ROOT, "docs/self-hosting");
const SH = readFileSync(join(ROOT, "scripts/selfhost.sh"), "utf8");

/** The body of a shell function, from `name() {` to its closing `}` at column 0. */
export function shellFunction(script: string, name: string): string {
  const start = script.indexOf(`\n${name}() {\n`);
  if (start < 0) throw new Error(`selfhost.sh has no ${name}()`);
  const end = script.indexOf("\n}\n", start);
  return script.slice(start, end + 3);
}

/** Which parser reads each subcommand's flags (main() and the cmd_* functions). */
export const PARSERS: Record<string, string | null> = {
  install: "parse_flags",
  upgrade: "parse_flags",
  backup: "parse_backup_flags",
  "reset-staging": "parse_reset_flags",
  "seed-mode": "parse_seed_flags",
  status: null,
};

export interface DocCommand {
  file: string;
  line: string;
  subcommand: string;
  flags: string[];
}

/** Fenced code blocks of a Markdown page, with backslash continuations joined. */
export function codeLines(markdown: string): string[] {
  const out: string[] = [];
  for (const m of markdown.matchAll(/^ *```[^\n]*\n([\s\S]*?)^ *```/gm))
    out.push(...(m[1] ?? "").replace(/\\\n\s*/g, " ").split("\n"));
  return out;
}

/** The selfhost.sh invocations in code lines: subcommand and `--flags`, up to a comment or pipe. */
export function docCommands(file: string, markdown: string): DocCommand[] {
  const out: DocCommand[] = [];
  for (const line of codeLines(markdown)) {
    const m = /selfhost\.sh["']?\s+(\S+)(.*)$/.exec(line);
    if (!m) continue;
    const rest = (m[2] ?? "").split(/\s#|\||&&|;/)[0] ?? "";
    const flags = [...rest.matchAll(/(?:^|\s)(--[a-z0-9][a-z0-9-]*)/g)].map((f) => f[1] ?? "");
    out.push({ file, line: line.trim(), subcommand: m[1] ?? "", flags });
  }
  return out;
}

const hasToken = (text: string, flag: string) =>
  new RegExp(`(^|[\\s|("'])${flag.replace(/-/g, "\\-")}([\\s|)="',]|$)`, "m").test(text);

/** What is wrong with one documented command (empty: the script accepts it). */
export function commandProblems(c: DocCommand, script: string): string[] {
  const usage = shellFunction(script, "usage");
  const main = shellFunction(script, "main");
  if (c.subcommand === "--help" || c.subcommand === "-h") return [];
  if (!new RegExp(`^\\s+${c.subcommand}\\)`, "m").test(main))
    return [`${c.file}: \`${c.line}\`: selfhost.sh has no command ${c.subcommand}`];
  const parser = PARSERS[c.subcommand];
  const problems: string[] = [];
  for (const flag of c.flags) {
    if (flag === "--help") continue;
    const parsed = parser ? hasToken(shellFunction(script, parser), flag) : false;
    if (!parsed) problems.push(`${c.file}: \`${c.line}\`: ${c.subcommand} does not take ${flag}`);
    if (!hasToken(usage, flag)) problems.push(`${c.file}: \`${c.line}\`: --help does not list ${flag}`);
  }
  return problems;
}

const pages = readdirSync(DOCS)
  .filter((f) => f.endsWith(".md"))
  .sort();
const commands = pages.flatMap((f) => docCommands(`docs/self-hosting/${f}`, readFileSync(join(DOCS, f), "utf8")));

describe("selfhost.sh commands in docs/self-hosting", () => {
  test("the docs have commands to check, on the pages that matter", () => {
    expect(commands.length).toBeGreaterThan(20);
    const files = new Set(commands.map((c) => c.file));
    for (const page of ["install.md", "upgrades.md", "captions.md", "p2p.md", "web-push.md", "configuration.md"])
      expect(files, page).toContain(`docs/self-hosting/${page}`);
  });

  test("every PARSERS entry is a command main() dispatches", () => {
    const main = shellFunction(SH, "main");
    for (const sub of Object.keys(PARSERS)) expect(main, sub).toMatch(new RegExp(`^\\s+${sub}\\)`, "m"));
  });

  test.each(pages)("%s: every command and flag is one selfhost.sh accepts and documents", (page) => {
    const problems = commands.filter((c) => c.file.endsWith(`/${page}`)).flatMap((c) => commandProblems(c, SH));
    expect(problems).toEqual([]);
  });
});

describe("the checker itself", () => {
  const script = [
    "usage() {",
    "  cat <<EOF",
    "  --version vX.Y.Z   a release",
    "  --captions         live captions",
    "EOF",
    "}",
    "parse_flags() {",
    "  case $1 in",
    "    --version | --bundle) shift 2 ;;",
    "    --captions) shift ;;",
    "  esac",
    "}",
    "main() {",
    "  case $_cmd in",
    "    install) cmd_install ;;",
    "    upgrade) cmd_upgrade ;;",
    "  esac",
    "}",
    "",
  ].join("\n");
  const one = (md: string) => docCommands("x.md", md);

  test("reads continued lines, stops at a comment or a pipe", () => {
    const md = [
      "```sh",
      'sh "commonair-selfhost_$VERSION/selfhost.sh" install --yes \\',
      "  --bundle x.tar.gz # --not-a-flag",
      "sh ~/commonair/selfhost.sh status | grep 'root CA' --color",
      "```",
      "outside a block: selfhost.sh install --nope",
    ].join("\n");
    expect(one(md)).toEqual([
      expect.objectContaining({ subcommand: "install", flags: ["--yes", "--bundle"] }),
      expect.objectContaining({ subcommand: "status", flags: [] }),
    ]);
  });

  test("a flag the parser lacks, one --help lacks, and an unknown command are all caught", () => {
    const [c] = one("```sh\nsh selfhost.sh upgrade --captions --bundle b --web-push\n```\n");
    expect(c && commandProblems(c, `\n${script}`)).toEqual([
      "x.md: `sh selfhost.sh upgrade --captions --bundle b --web-push`: --help does not list --bundle",
      "x.md: `sh selfhost.sh upgrade --captions --bundle b --web-push`: upgrade does not take --web-push",
      "x.md: `sh selfhost.sh upgrade --captions --bundle b --web-push`: --help does not list --web-push",
    ]);
    const [d] = one("```sh\nsh selfhost.sh uninstall\n```\n");
    expect(d && commandProblems(d, `\n${script}`)).toEqual([
      "x.md: `sh selfhost.sh uninstall`: selfhost.sh has no command uninstall",
    ]);
  });

  test("a flag is matched whole, not as a prefix of a longer one", () => {
    expect(hasToken("  --captions-model <path>", "--captions")).toBe(false);
    expect(hasToken("  --captions | --no-captions)", "--captions")).toBe(true);
  });
});
