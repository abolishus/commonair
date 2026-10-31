// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `UiMessages` from `src/locales/<lang>/ui.json` (batch 5 decision (c)). */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DISCOVERY_REASONS } from "@commonair/contracts/dto";
import { PSEUDO_LOCALE, pseudoLocalize } from "@commonair/i18n";
import { checkCatalog, coverage, readNamespaces } from "@commonair/i18n/catalog";
import { describe, expect, test } from "vite-plus/test";
import es from "../src/locales/es/ui.json" with { type: "json" };
import {
  UI_CATALOGS,
  type UiCatalog,
  type UiMessages,
  enMessages,
  enUiCatalog,
  uiMessagesFromCatalog,
} from "../src/lib/messages.ts";

const localesDir = join(import.meta.dirname, "../src/locales");

const pseudo: UiCatalog = Object.fromEntries(
  Object.entries(enUiCatalog).map(([key, message]) => [key, pseudoLocalize(message)]),
);

const built: Record<string, UiMessages> = {
  en: enMessages,
  es: uiMessagesFromCatalog("es", es),
  [PSEUDO_LOCALE]: uiMessagesFromCatalog(PSEUDO_LOCALE, pseudo),
};

/** Every string a `UiMessages` yields, with the path that yields it (functions called once). */
function leaves(messages: UiMessages): Array<[path: string, value: unknown]> {
  const out: Array<[string, unknown]> = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "function") out.push([path, (value as (f: string, n: number) => unknown)("1,234", 1234)]);
    else if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key);
    else out.push([path, value]);
  };
  walk(messages, "");
  return out;
}

describe("the catalogs", () => {
  const namespaces = readNamespaces(localesDir);

  test("parse, have unique keys and keep English's arguments (parity)", () => {
    expect(checkCatalog(namespaces)).toEqual([]);
  });

  test("es covers 100% of English", () => {
    const es = coverage(namespaces, "es");
    expect(es.missing).toEqual([]);
    expect(es.translated).toBe(es.total);
    expect(es.total).toBe(Object.keys(enUiCatalog).length);
  });

  test("UI_CATALOGS lists every locales/<lang>/ui.json and nothing else", async () => {
    const onDisk = readdirSync(localesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(Object.keys(UI_CATALOGS).sort()).toEqual(onDisk);
    for (const lang of onDisk) expect(namespaces.find((ns) => ns.lang === lang)?.name).toBe("ui");
    expect(await UI_CATALOGS.en?.()).toBe(enUiCatalog);
    expect(await UI_CATALOGS.es?.()).toEqual(es);
  });

  test("every English key is read by uiMessagesFromCatalog", () => {
    // A catalog whose messages are their own keys shows which keys the builder reads.
    const marked = Object.fromEntries(Object.keys(enUiCatalog).map((key) => [key, `<${key}>`]));
    const seen = new Set(
      leaves(uiMessagesFromCatalog("en", marked)).map(([, value]) => String(value).replace(/^<|>$/g, "")),
    );
    expect([...seen].sort()).toEqual(Object.keys(enUiCatalog).sort());
  });
});

describe.each(Object.keys(built))("UiMessages in %s", (locale) => {
  const messages = built[locale] as UiMessages;

  test("every field resolves to a non-empty translated string", () => {
    const all = leaves(messages);
    expect(all.length).toBe(Object.keys(enUiCatalog).length);
    for (const [path, value] of all) {
      expect(typeof value, path).toBe("string");
      expect(value, path).not.toBe("");
      expect(String(value), path).not.toMatch(/^ui\.|\{/);
    }
  });

  test("covers every discovery reason", () => {
    expect(Object.keys(messages.discoveryReason).sort()).toEqual([...DISCOVERY_REASONS].sort());
  });
});

describe("viewerCount", () => {
  test.each([
    [0, "0 verified viewers", "0 espectadores verificados"],
    [1, "1 verified viewer", "1 espectador verificado"],
    [2, "2 verified viewers", "2 espectadores verificados"],
    [1000, "1,000 verified viewers", "1.000 espectadores verificados"],
  ])("%i", (count, en, esText) => {
    const formatted = new Intl.NumberFormat("en").format(count);
    expect(built.en?.viewerCount(formatted, count)).toBe(en);
    expect(built.es?.viewerCount(formatted.replace(",", "."), count)).toBe(esText);
  });

  test("en-XA keeps the plural working", () => {
    expect(built[PSEUDO_LOCALE]?.viewerCount("1", 1)).toMatch(/^\[1 ṽéŕîƒîéð ṽîéŵéŕ~+\]$/);
    expect(built[PSEUDO_LOCALE]?.viewerCount("2", 2)).toMatch(/^\[2 ṽéŕîƒîéð ṽîéŵéŕš~+\]$/);
  });
});

describe("uiMessagesFromCatalog", () => {
  test("Spanish strings", () => {
    const m = built.es as UiMessages;
    expect(m.close).toBe("Cerrar");
    expect(m.theme.dark).toBe("Oscuro");
    expect(m.discoveryReason.new).toBe("Streamer nuevo");
    expect(m.live).toBe("En vivo");
  });

  test("a missing, empty or unparsable key falls back to English per key", () => {
    const partial: UiCatalog = { ...es, "ui.close": "", "ui.theme.dark": "{broken" };
    const { "ui.cancel": _cancel, ...withoutCancel } = partial;
    const m = uiMessagesFromCatalog("es", withoutCancel);
    expect(m.cancel).toBe("Cancel");
    expect(m.close).toBe("Close");
    expect(m.confirm).toBe("Confirmar");
    // An unparsable translation shows its raw source rather than breaking the page.
    expect(m.theme.dark).toBe("{broken");
  });

  test("a custom fallback", () => {
    const m = uiMessagesFromCatalog("es", {}, es);
    expect(m.close).toBe("Cerrar");
  });

  test("enMessages is built from en/ui.json", () => {
    expect(enMessages.close).toBe(enUiCatalog["ui.close"]);
    expect(enMessages.sidebar.toggle).toBe("Toggle sidebar");
  });
});
