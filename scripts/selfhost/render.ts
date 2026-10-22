// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Renders the repository's Quadlet units for a release (ADR 0023 §6): every
 * `Image=localhost/commonair/<name>:latest` becomes `imageRef(manifest, name, registry)`, i.e.
 * `<registry>/<name>:<version>@<digest>`. Third-party images keep their digest pins.
 *
 *   bun scripts/selfhost/render.ts --manifest <release-manifest.json> --out <dir> [--registry <r>]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  RELEASE_IMAGES,
  imageRef,
  parseManifest,
  type ReleaseImage,
  type ReleaseManifest,
} from "../release/manifest.ts";
import { QUADLET_DIR, readUnitDir } from "./units.ts";

/** How the repository's units name our own images (built from source, never pulled). */
export const OWN_IMAGE_LINE = /^Image=localhost\/commonair\/([^:\s]+):latest$/gm;

const isReleaseImage = (name: string): name is ReleaseImage => (RELEASE_IMAGES as readonly string[]).includes(name);

/** One unit's text with our images pinned to the release. */
export function renderUnit(unit: string, manifest: ReleaseManifest, registry?: string): string {
  const rendered = unit.replace(OWN_IMAGE_LINE, (_line, name: string) => {
    if (!isReleaseImage(name)) throw new Error(`unit uses localhost/commonair/${name}, which is not a release image`);
    return `Image=${imageRef(manifest, name, registry)}`;
  });
  // A locally built image must never reach a release (another tag would slip past the pattern).
  const local = /^Image=localhost\/.*$/m.exec(rendered);
  if (local) throw new Error(`unrenderable local image: ${local[0]}`);
  return rendered;
}

/** Every unit, by file name. Units without an image (volumes, the network) pass through. */
export function renderUnits(
  units: Map<string, string>,
  manifest: ReleaseManifest,
  registry?: string,
): Map<string, string> {
  return new Map([...units].map(([name, text]) => [name, renderUnit(text, manifest, registry)]));
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const manifestPath = arg(argv, "--manifest");
  const out = arg(argv, "--out");
  if (!manifestPath || !out) {
    console.error(
      "usage: bun scripts/selfhost/render.ts --manifest <release-manifest.json> --out <dir> [--registry <r>]",
    );
    process.exit(2);
  }
  try {
    const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
    const root = new URL("../../", import.meta.url).pathname;
    const rendered = renderUnits(readUnitDir(join(root, QUADLET_DIR)), manifest, arg(argv, "--registry"));
    mkdirSync(out, { recursive: true });
    for (const [name, text] of rendered) writeFileSync(join(out, name), text);
    console.log(out);
  } catch (e) {
    console.error(`render: ${(e as Error).message}`);
    process.exit(1);
  }
}
