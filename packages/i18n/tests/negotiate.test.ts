// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vite-plus/test";
import { localeDirection, negotiateLocale, parseAcceptLanguage, pickLocale } from "../src/index.ts";

describe("parseAcceptLanguage", () => {
  it("orders by descending q, stable on ties", () => {
    expect(parseAcceptLanguage("fr;q=0.5, es-MX, en;q=0.8, de")).toEqual(["es-MX", "de", "en", "fr"]);
    expect(parseAcceptLanguage("a;q=0.5,b;q=0.5,c;q=0.5")).toEqual(["a", "b", "c"]);
    expect(parseAcceptLanguage("en;q=1.000, fr;q=0.001")).toEqual(["en", "fr"]);
  });

  it("drops *, q=0 and malformed parts", () => {
    expect(parseAcceptLanguage("*, es")).toEqual(["es"]);
    expect(parseAcceptLanguage("es;q=0, fr;q=0.0, de;q=0.000, it")).toEqual(["it"]);
    expect(
      parseAcceptLanguage("es;q=2, fr;q=abc, de;q=0.12345, x y, 12, en-, -en, toolongtag1, it;foo=bar, pt"),
    ).toEqual(["pt"]);
    expect(parseAcceptLanguage(" , ;q=0.5,,en ")).toEqual(["en"]);
  });

  it("handles empty input", () => {
    expect(parseAcceptLanguage(undefined)).toEqual([]);
    expect(parseAcceptLanguage(null)).toEqual([]);
    expect(parseAcceptLanguage("")).toEqual([]);
  });

  it("keeps at most 20 tags", () => {
    const letter = (n: number) => String.fromCharCode(97 + n);
    const header = Array.from({ length: 30 }, (_, i) => `a${letter(Math.floor(i / 26))}${letter(i % 26)}`).join(",");
    const tags = parseAcceptLanguage(header);
    expect(tags).toHaveLength(20);
    expect(tags[0]).toBe("aaa");
    expect(tags[19]).toBe("aat");
  });

  it("keeps the tag's case and accepts any q case", () => {
    expect(parseAcceptLanguage("EN-gb;Q=0.9, pt-BR")).toEqual(["pt-BR", "EN-gb"]);
  });

  it("bounds the work for a huge header", () => {
    expect(parseAcceptLanguage(`${"x,".repeat(100_000)}en`)).toHaveLength(20);
  });
});

describe("negotiateLocale", () => {
  const supported = ["en", "es", "pt-BR", "en-XA"];

  it("matches exactly, case-insensitively, returning the supported spelling", () => {
    expect(negotiateLocale(["PT-br"], supported)).toBe("pt-BR");
    expect(negotiateLocale(["es"], supported)).toBe("es");
  });

  it("falls back to the language subtag", () => {
    expect(negotiateLocale(["es-MX"], supported)).toBe("es");
    expect(negotiateLocale(["en-GB"], supported)).toBe("en");
    expect(negotiateLocale(["zh-Hant-TW"], ["zh"])).toBe("zh");
  });

  it("tries candidates in order", () => {
    expect(negotiateLocale(["fr", "de-AT", "es-AR", "en"], supported)).toBe("es");
    expect(negotiateLocale(["fr", "de"], supported)).toBeUndefined();
    expect(negotiateLocale([], supported)).toBeUndefined();
  });

  it("reaches en-XA only exactly", () => {
    expect(negotiateLocale(["en-XA"], supported)).toBe("en-XA");
    expect(negotiateLocale(["en-xa"], supported)).toBe("en-XA");
    expect(negotiateLocale(["en"], ["en-XA"])).toBeUndefined();
    expect(negotiateLocale(["en-US"], ["en-XA"])).toBeUndefined();
    // A language-only candidate does not widen to a regional supported tag.
    expect(negotiateLocale(["pt"], supported)).toBeUndefined();
  });
});

describe("pickLocale", () => {
  const supported = ["en", "es", "en-XA"];
  const base = { instanceDefault: "en", supported };

  it("prefers the member's own choice", () => {
    expect(pickLocale({ ...base, userLocale: "es", stored: "en-XA", acceptLanguage: "en" })).toBe("es");
    expect(pickLocale({ ...base, userLocale: "es-MX" })).toBe("es");
  });

  it("uses the stored choice when the member has none (null) or is signed out", () => {
    expect(pickLocale({ ...base, userLocale: null, stored: "es", acceptLanguage: "en" })).toBe("es");
    expect(pickLocale({ ...base, stored: "en-XA", acceptLanguage: "es" })).toBe("en-XA");
  });

  it("then Accept-Language", () => {
    expect(pickLocale({ ...base, userLocale: null, stored: null, acceptLanguage: "fr, es-MX;q=0.9" })).toBe("es");
    expect(pickLocale({ ...base, acceptLanguage: "en-US" })).toBe("en");
  });

  it("then the instance default, then en", () => {
    expect(pickLocale({ instanceDefault: "es", supported, acceptLanguage: "fr" })).toBe("es");
    expect(pickLocale({ instanceDefault: "es-AR", supported })).toBe("es");
    expect(pickLocale({ instanceDefault: "fr", supported })).toBe("en");
    expect(pickLocale({ instanceDefault: "fr", supported: ["es"] })).toBe("en");
  });

  it("skips unsupported choices at every step", () => {
    expect(pickLocale({ ...base, userLocale: "fr", stored: "de", acceptLanguage: "it, es;q=0.1" })).toBe("es");
    expect(pickLocale({ ...base, stored: "garbage!", acceptLanguage: "" })).toBe("en");
  });

  it("never reaches en-XA through Accept-Language fallback", () => {
    expect(pickLocale({ instanceDefault: "fr", supported: ["en-XA", "es"], acceptLanguage: "en-US, en" })).toBe("en");
  });
});

describe("localeDirection", () => {
  it.each([
    ["ar", "rtl"],
    ["ar-EG", "rtl"],
    ["he", "rtl"],
    ["fa-IR", "rtl"],
    ["ur", "rtl"],
    ["ps", "rtl"],
    ["yi", "rtl"],
    ["dv", "rtl"],
    ["ckb", "rtl"],
    ["sd", "rtl"],
    ["ug", "rtl"],
    ["pa-Arab", "rtl"],
    ["ku-Arab-IQ", "rtl"],
    ["jrb-Hebr", "rtl"],
    ["uz-Latn", "ltr"],
    ["en", "ltr"],
    ["en-XA", "ltr"],
    ["es-MX", "ltr"],
    ["", "ltr"],
  ] as const)("%s → %s", (tag, dir) => {
    expect(localeDirection(tag)).toBe(dir);
  });
});
