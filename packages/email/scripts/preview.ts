// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Render every template with sample data to `.preview/<id>.html` (+ `.txt`)
 * for a quick look in a browser. Identity comes from the environment, like a
 * real instance: `PUBLIC_URL=https://air.example.test bun run preview`.
 * `--locale <tag>` previews a bundled locale (`es`); a regional tag (`es-MX`) uses its language's
 * strings and any other tag English strings, both with the tag's own date and number formatting.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coreEnv, instanceSite, loadEnv } from "@commonair/config";
import { BUNDLED, renderEmail, resolveCatalog, sampleData, TEMPLATE_IDS } from "../src/index.ts";

const args = process.argv.slice(2);
const localeIdx = args.indexOf("--locale");
const locale = localeIdx >= 0 ? args[localeIdx + 1] : undefined;

const site = instanceSite(loadEnv(coreEnv));
const samples = sampleData(site.publicUrl);
const out = join(import.meta.dir, "..", ".preview");
mkdirSync(out, { recursive: true });

// Register the requested tag itself, so a regional (`es-MX`) or unbundled tag keeps its own date
// and number formatting over the strings of the locale it resolves to.
const resolved = locale ? resolveCatalog(locale).locale : undefined;
const catalogs =
  locale && resolved && resolved !== locale ? { ...BUNDLED, [locale]: BUNDLED[resolved] ?? {} } : BUNDLED;
const index: string[] = [];
for (const id of TEMPLATE_IDS) {
  const mail = await renderEmail(id, samples[id], { site, locale, catalogs });
  writeFileSync(join(out, `${id}.html`), mail.html);
  writeFileSync(join(out, `${id}.txt`), `Subject: ${mail.subject}\n\n${mail.text}\n`);
  index.push(`<li><a href="${id}.html">${id}</a> (<a href="${id}.txt">text</a>): ${Bun.escapeHTML(mail.subject)}</li>`);
}
writeFileSync(join(out, "index.html"), `<!DOCTYPE html><meta charset="utf-8"><ul>${index.join("")}</ul>\n`);
process.stdout.write(`Rendered ${TEMPLATE_IDS.length} templates to ${out}\n`);
