// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Workspace closure for one image: the service's own workspace plus every
 * `workspace:` dependency it reaches, transitively. The Containerfile uses it to
 * install only those workspaces' npm dependencies and copy only their sources.
 *
 *   bun infra/containers/closure.ts <service> [--dev] [--root <repo>]
 *     prints one workspace directory per line (relative to the repo root)
 *
 * `--dev` follows devDependencies of the roots as well (the web build needs Vite).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Image name → root workspace directories. Everything else is `services/<name>`. */
export const SPECIAL_ROOTS: Record<string, string[]> = {
  web: ["apps/web"],
  // One-shot jobs: `migrate` (packages/db + infra/postgres) and `garage-init` (infra/garage).
  tools: ["packages/db", "infra"],
};

export function rootsFor(service: string): string[] {
  if (!/^[a-z][a-z0-9-]*$/.test(service)) throw new Error(`invalid service name: ${service}`);
  return SPECIAL_ROOTS[service] ?? [`services/${service}`];
}

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

type ReadManifest = (dir: string) => Manifest | undefined;

/** Map package name → workspace dir by expanding the root `workspaces` globs (`dir/*` or `dir`). */
export function workspaceIndex(root: string, read: ReadManifest, list: (dir: string) => string[]): Map<string, string> {
  const rootManifest = read(".") as (Manifest & { workspaces?: string[] }) | undefined;
  if (!rootManifest) throw new Error(`no package.json in ${root}`);
  const index = new Map<string, string>();
  for (const pattern of rootManifest.workspaces ?? []) {
    const dirs = pattern.endsWith("/*")
      ? list(pattern.slice(0, -2)).map((d) => `${pattern.slice(0, -2)}/${d}`)
      : [pattern];
    for (const dir of dirs) {
      const m = read(dir);
      if (m?.name) index.set(m.name, dir);
    }
  }
  return index;
}

export function closure(roots: string[], index: Map<string, string>, read: ReadManifest, dev: boolean): string[] {
  const seen = new Set<string>();
  const queue = roots.map((dir) => ({ dir, isRoot: true }));
  for (let next = queue.shift(); next; next = queue.shift()) {
    const { dir, isRoot } = next;
    if (seen.has(dir)) continue;
    const m = read(dir);
    if (!m) throw new Error(`workspace ${dir} has no package.json`);
    seen.add(dir);
    const deps = { ...m.dependencies, ...m.optionalDependencies, ...(dev && isRoot ? m.devDependencies : {}) };
    for (const [name, spec] of Object.entries(deps)) {
      if (!spec.startsWith("workspace:")) continue;
      const target = index.get(name);
      if (!target) throw new Error(`${dir} depends on ${name}, which is not a workspace`);
      queue.push({ dir: target, isRoot: false });
    }
  }
  return [...seen].sort();
}

function fsReader(root: string): { read: ReadManifest; list: (dir: string) => string[] } {
  return {
    read: (dir) => {
      const p = join(root, dir, "package.json");
      return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Manifest) : undefined;
    },
    list: (dir) => {
      const p = join(root, dir);
      if (!existsSync(p)) return [];
      return [...new Bun.Glob("*/package.json").scanSync({ cwd: p })].map((f) => f.slice(0, f.indexOf("/")));
    },
  };
}

export function serviceClosure(service: string, opts: { root?: string; dev?: boolean } = {}): string[] {
  const root = opts.root ?? ".";
  const { read, list } = fsReader(root);
  return closure(rootsFor(service), workspaceIndex(root, read, list), read, opts.dev ?? false);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const service = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--root");
  const rootIdx = args.indexOf("--root");
  if (!service) {
    console.error("usage: bun infra/containers/closure.ts <service> [--dev] [--root <repo>]");
    process.exit(2);
  }
  try {
    const dirs = serviceClosure(service, {
      root: rootIdx === -1 ? "." : args[rootIdx + 1],
      dev: args.includes("--dev"),
    });
    process.stdout.write(`${dirs.join("\n")}\n`);
  } catch (e) {
    console.error(`closure: ${(e as Error).message}`);
    process.exit(1);
  }
}
