// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The environment reference in docs/self-hosting/configuration.md, generated from the schemas
 * so it cannot drift from what the services validate:
 *
 *   bun scripts/config-reference.ts           rewrite the generated block in place
 *   bun scripts/config-reference.ts --check   exit 1 if the committed block is out of date
 *
 * Per variable: the schema group (`ALL_ENV_SCHEMAS`), the default and whether a service refuses
 * to start without it (both from the schema itself), a description (the JSDoc in env.ts, else
 * the comment above it in .env.example), and what a self-hosted install does with it (read
 * from scripts/selfhost.sh, the Quadlet units and the `__generate…__` markers in .env.example).
 * The description is mandatory: a test fails on any variable without one.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { ALL_ENV_SCHEMAS } from "../packages/config/src/env.ts";

export const REPO_ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
export const DOC_PATH = "docs/self-hosting/configuration.md";
export const BEGIN_MARKER = "<!-- BEGIN GENERATED: bun scripts/config-reference.ts -->";
export const END_MARKER = "<!-- END GENERATED -->";

export interface EnvVar {
  name: string;
  group: string;
  required: boolean;
  /** The schema's default as text, or null when it has none. */
  defaultText: string | null;
  description: string;
  selfHost: string[];
}

export interface Sources {
  envTs: string;
  envExample: string;
  selfhostSh: string;
  /** Quadlet `.container` files' text. */
  units: string[];
}

export function readSources(root: string = REPO_ROOT): Sources {
  const quadlet = join(root, "infra/quadlet");
  return {
    envTs: readFileSync(join(root, "packages/config/src/env.ts"), "utf8"),
    envExample: readFileSync(join(root, ".env.example"), "utf8"),
    selfhostSh: readFileSync(join(root, "scripts/selfhost.sh"), "utf8"),
    units: readdirSync(quadlet)
      .filter((f) => f.endsWith(".container"))
      .sort()
      .map((f) => readFileSync(join(quadlet, f), "utf8")),
  };
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** `/** … *\/` immediately above `KEY:` in env.ts, as one line. */
export function jsDocs(envTs: string): Map<string, string> {
  const docs = new Map<string, string>();
  for (const m of envTs.matchAll(/\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*\n\s*([A-Z][A-Z0-9_]*):/g)) {
    const text = (m[1] ?? "")
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, ""))
      .join(" ");
    if (m[2]) docs.set(m[2], oneLine(text));
  }
  return docs;
}

/** Keys in .env.example, each with the comment lines directly above it (section rulers excluded). */
export function exampleEntries(envExample: string): Map<string, { value: string; comment: string }> {
  const out = new Map<string, { value: string; comment: string }>();
  let comment: string[] = [];
  for (const line of envExample.split("\n")) {
    const kv = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (kv?.[1]) {
      out.set(kv[1], { value: kv[2] ?? "", comment: oneLine(comment.join(" ")) });
      comment = [];
    } else if (line.startsWith("# ---") || line.trim() === "") {
      comment = [];
    } else if (line.startsWith("#")) {
      comment.push(line.replace(/^#\s?/, ""));
    }
  }
  return out;
}

/** Keys `selfhost.sh install` writes into commonair.env (`env_set`/`env_default`, also in a loop). */
export function installKeys(selfhostSh: string): Set<string> {
  const keys = new Set<string>();
  for (const m of selfhostSh.matchAll(/^\s*env_(?:set|default) ([A-Z][A-Z0-9_]*) /gm)) if (m[1]) keys.add(m[1]);
  for (const m of selfhostSh.matchAll(/for _k in ([A-Z0-9_ ]+); do env_(?:set|default) /g))
    for (const k of (m[1] ?? "").split(" ")) if (k) keys.add(k);
  return keys;
}

/**
 * What the Quadlet units do with each key. `pinned`: some unit sets a value (`Environment=K=v`,
 * `Secret=…,target=K`), which wins over the env file. `blanked`: units only ever set it empty
 * (`Environment=K=`), which hides an env-file secret from the services that must not hold it;
 * the services that need it still read the env file.
 */
export function unitKeys(units: string[]): { pinned: Set<string>; blanked: Set<string> } {
  const pinned = new Set<string>();
  const empty = new Set<string>();
  for (const u of units) {
    for (const m of u.matchAll(/^Environment=([A-Z][A-Z0-9_]*)=(.*)$/gm)) {
      if (!m[1]) continue;
      if ((m[2] ?? "").trim() === "") empty.add(m[1]);
      else pinned.add(m[1]);
    }
    for (const m of u.matchAll(/^Secret=[^\n]*\btarget=([A-Z][A-Z0-9_]*)/gm)) if (m[1]) pinned.add(m[1]);
  }
  return { pinned, blanked: new Set([...empty].filter((k) => !pinned.has(k))) };
}

const MAX_DEFAULT = 40;

export function formatDefault(value: unknown): string | null {
  if (value === undefined) return null;
  let text: string;
  if (Array.isArray(value)) text = value.join(",");
  else if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else text = JSON.stringify(value);
  if (text === "") return "(empty)";
  if (text.length > MAX_DEFAULT) text = `${text.slice(0, MAX_DEFAULT - 1)}…`;
  return `\`${text}\``;
}

export function collect(sources: Sources, schemas: Record<string, z.ZodObject> = ALL_ENV_SCHEMAS): EnvVar[] {
  const docs = jsDocs(sources.envTs);
  const example = exampleEntries(sources.envExample);
  const installed = installKeys(sources.selfhostSh);
  const { pinned, blanked } = unitKeys(sources.units);
  const seen = new Set<string>();
  const vars: EnvVar[] = [];
  for (const [group, schema] of Object.entries(schemas)) {
    for (const [name, field] of Object.entries(schema.shape)) {
      if (seen.has(name)) continue;
      seen.add(name);
      // A field that accepts "unset" is optional; what it yields then is its default.
      const unset = (field as z.ZodType).safeParse(undefined);
      const ex = example.get(name);
      const selfHost: string[] = [];
      if (ex?.value.startsWith("__generate")) selfHost.push("generated");
      if (installed.has(name)) selfHost.push("set by install");
      if (pinned.has(name)) selfHost.push("set in the units");
      if (blanked.has(name)) selfHost.push("env file (blanked in units that must not see it)");
      vars.push({
        name,
        group,
        required: !unset.success,
        defaultText: unset.success ? formatDefault(unset.data) : null,
        description: docs.get(name) ?? ex?.comment ?? "",
        selfHost,
      });
    }
  }
  return vars;
}

// `<public host>` would otherwise read as an HTML tag.
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/</g, "\\<");

/** A Markdown table padded the way `vp fmt` (Oxfmt) pads it, so formatting leaves it unchanged. */
export function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) =>
    Math.max(3, ...[h, ...rows.map((r) => r[i] ?? "")].map((c) => Bun.stringWidth(c))),
  );
  const line = (cells: string[]) =>
    `| ${cells.map((c, i) => c + " ".repeat((widths[i] ?? 0) - Bun.stringWidth(c))).join(" | ")} |`;
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)];
}

export function renderReference(vars: EnvVar[]): string {
  const out: string[] = [BEGIN_MARKER, ""];
  const groups = [...new Set(vars.map((v) => v.group))];
  for (const group of groups) {
    out.push(`### \`${group}\``, "");
    const rows = vars
      .filter((x) => x.group === group)
      .map((v) => [
        `\`${v.name}\``,
        v.required ? "yes" : "no",
        v.defaultText ?? "—",
        v.selfHost.join(", ") || "—",
        cell(v.description) || "—",
      ]);
    out.push(...table(["Variable", "Required", "Default", "Self-host", "Description"], rows), "");
  }
  out.push(END_MARKER);
  return out.join("\n");
}

/** Table padding and line breaks do not change the content (a formatter may realign tables). */
export function normalize(block: string): string {
  return block
    .split("\n")
    .map((l) => (l.startsWith("|") ? l.replace(/ {2,}/g, " ").replace(/-{3,}/g, "---") : l).trimEnd())
    .join("\n");
}

/** Whether the document's generated block matches what the sources generate now. */
export function isUpToDate(doc: string, block: string): boolean {
  return normalize(generatedBlock(doc)) === normalize(block);
}

/** The generated block of a document, markers included; throws if the markers are missing. */
export function generatedBlock(doc: string): string {
  const start = doc.indexOf(BEGIN_MARKER);
  const end = doc.indexOf(END_MARKER);
  if (start < 0 || end < start) throw new Error(`${DOC_PATH} lacks the generated-block markers`);
  return doc.slice(start, end + END_MARKER.length);
}

export function replaceBlock(doc: string, block: string): string {
  return doc.replace(generatedBlock(doc), block);
}

/** Variable names listed in the generated tables of a document. */
export function documentedNames(doc: string): string[] {
  return [...generatedBlock(doc).matchAll(/^\| `([A-Z][A-Z0-9_]*)` +\|/gm)].map((m) => m[1] ?? "");
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const path = join(REPO_ROOT, DOC_PATH);
  const doc = readFileSync(path, "utf8");
  const block = renderReference(collect(readSources()));
  if (check) {
    if (!isUpToDate(doc, block)) {
      console.error(`${DOC_PATH} is out of date: run bun scripts/config-reference.ts`);
      process.exit(1);
    }
    console.log(`${DOC_PATH} is up to date`);
  } else {
    const next = replaceBlock(doc, block);
    writeFileSync(path, next);
    console.log(`${DOC_PATH}: ${documentedNames(next).length} variables`);
  }
}
