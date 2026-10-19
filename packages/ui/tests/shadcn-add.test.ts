// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  COMPONENTS,
  HEADER,
  SHADCN_VERSION,
  normalizeComponentSource,
  normalizePackageJson,
  rewriteProbeAliases,
  upstreamName,
} from "../scripts/shadcn-add.ts";

describe("shadcn-add post-processing", () => {
  test("the CLI is pinned to 4.21.1 and the README names the same version", () => {
    expect(SHADCN_VERSION).toBe("4.21.1");
    const readme = readFileSync(join(import.meta.dirname, "../README.md"), "utf8");
    const mentioned = [...readme.matchAll(/shadcn@(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    expect(mentioned.length).toBeGreaterThan(0);
    expect(new Set(mentioned)).toEqual(new Set([SHADCN_VERSION]));
  });

  test("normalizes hooks files too (SPDX header on a .ts file without cn)", () => {
    const raw = 'import * as React from "react"\n\nexport function useIsMobile() {}\n';
    expect(normalizeComponentSource(raw)).toBe(`${HEADER}\n${raw}`);
  });

  test("maps a scratch preset project's @/ aliases onto the package aliases", () => {
    const raw = [
      'import { Button } from "@/components/ui/button"',
      "import { useIsMobile } from '@/hooks/use-mobile'",
      'import { cn } from "@/lib/utils"',
      'import { thing } from "@/other"',
    ].join("\n");
    expect(rewriteProbeAliases(raw)).toBe(
      [
        'import { Button } from "@commonair/ui/components/button"',
        "import { useIsMobile } from '@commonair/ui/hooks/use-mobile'",
        'import { cn } from "@commonair/ui/lib/utils"',
        'import { thing } from "@/other"',
      ].join("\n"),
    );
  });

  test("upstream files are stored as text so lint and typecheck skip them", () => {
    expect(upstreamName("button.tsx")).toBe("button.tsx.txt");
    expect(new Set(COMPONENTS).size).toBe(COMPONENTS.length);
    expect(COMPONENTS).toContain("sidebar");
    expect(COMPONENTS).toContain("chart");
  });

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
    // The preset's menu style (b1ZhhFNpx): inverted popups with a bold highlight.
    expect(config).toMatchObject({ menuColor: "inverted", menuAccent: "bold" });
    expect(config.tailwind).toMatchObject({ baseColor: "zinc", cssVariables: true, css: "src/styles/globals.css" });
    for (const alias of Object.values(config.aliases)) expect(alias.startsWith("@commonair/ui/")).toBe(true);
  });
});
