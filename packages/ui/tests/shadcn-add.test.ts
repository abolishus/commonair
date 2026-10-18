// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { HEADER, normalizeComponentSource, normalizePackageJson } from "../scripts/shadcn-add.ts";

describe("shadcn-add post-processing", () => {
  test("rewrites the cn import and adds the SPDX header once", () => {
    const raw = 'import * as React from "react"\nimport { cn } from "cn"\n';
    const once = normalizeComponentSource(raw);
    expect(once.startsWith(HEADER)).toBe(true);
    expect(once).toContain('import { cn } from "@commonair/ui/lib/utils"');
    expect(once).not.toMatch(/from "cn"/);
    expect(normalizeComponentSource(once)).toBe(once);
  });

  test("drops replaced registry dependencies and flags unpinned ones", () => {
    const pkg = {
      dependencies: {
        cn: "^0.5.0",
        "next-themes": "^0.4.6",
        cmdk: "^1.1.1",
        "@base-ui/react": "1.9.0",
        "@commonair/contracts": "workspace:*",
        vaul: "^1.0.0",
      },
    };
    expect(normalizePackageJson(pkg)).toEqual(["vaul@^1.0.0"]);
    expect(Object.keys(pkg.dependencies)).toEqual(["@base-ui/react", "@commonair/contracts", "vaul"]);
  });

  test("components.json selects base-lyra, zinc, CSS variables and Hugeicons with in-package aliases", () => {
    const config = JSON.parse(readFileSync(join(import.meta.dirname, "../components.json"), "utf8")) as {
      style: string;
      iconLibrary: string;
      tailwind: { baseColor: string; cssVariables: boolean; css: string };
      aliases: Record<string, string>;
    };
    expect(config.style).toBe("base-lyra");
    expect(config.iconLibrary).toBe("hugeicons");
    expect(config.tailwind).toMatchObject({ baseColor: "zinc", cssVariables: true, css: "src/styles/globals.css" });
    for (const alias of Object.values(config.aliases)) expect(alias.startsWith("@commonair/ui/")).toBe(true);
  });
});
