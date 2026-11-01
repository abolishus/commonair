// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { pseudoLocalize } from "../../../packages/i18n/src/pseudo.ts";
import {
  type ChannelText,
  PSEUDO_LOCALE,
  channelUserContent,
  expectedFooterLicense,
  hitsDataKey,
  localeParam,
  redactHits,
  scanStepName,
  stringsIn,
  webCatalogMessage,
  webLocales,
} from "./pseudo-run.ts";
import { untranslatedWords } from "./literals.ts";

const param = (value: string) => ({ param: (_name: string, fallback: string) => value || fallback });

describe("localeParam", () => {
  test("absent or blank means today's behaviour", () => {
    expect(localeParam(param(""))).toBeUndefined();
    expect(localeParam(param("  "))).toBeUndefined();
  });

  test("canonicalizes the tag", () => {
    expect(localeParam(param("en-xa"))).toBe(PSEUDO_LOCALE);
    expect(localeParam(param("ES"))).toBe("es");
  });

  test("rejects something that is not a tag", () => {
    expect(() => localeParam(param("not a tag!"))).toThrow(RangeError);
  });
});

describe("report names", () => {
  test("the step name is the one the brief fixes", () => {
    expect(scanStepName("anon", "the offline state (webkit)")).toBe(
      "anon: no untranslated text on the offline state (webkit)",
    );
  });

  test("data keys are flat and safe", () => {
    expect(hitsDataKey("fan", "the channel page (signed in, live)")).toBe(
      "untranslated.fan.the_channel_page_signed_in_live_",
    );
  });
});

describe("redactHits", () => {
  test("blanks secrets out of the reported text only", () => {
    const hits = [{ kind: "text" as const, text: "Key sk_live_abc copied", selector: "p", words: ["Key", "copied"] }];
    expect(redactHits(hits, ["sk_live_abc", ""])).toEqual([{ ...hits[0], text: "Key [redacted] copied" }]);
  });
});

describe("stringsIn", () => {
  test("collects nested non-blank strings once", () => {
    expect([...stringsIn({ a: "x", b: ["y", { c: "x", d: " " }], e: 3, f: null })]).toEqual(["x", "y"]);
  });
});

describe("channelUserContent", () => {
  test("takes what the page shows, nothing else", () => {
    const c: ChannelText = {
      slug: "e2e_st_1",
      displayName: "Streamer One",
      title: "My first stream",
      description: "",
      category: { name: "Just Chatting" },
      tags: ["cozy"],
      owner: { username: "e2e_st_1", displayName: "Streamer One" },
      live: { title: "Live title", category: null },
      panels: [{ title: "About", body: "Hi there", linkUrl: null }],
      subTiers: [{ name: "Tier 1", benefits: "Emotes" }],
    };
    const content = channelUserContent(c);
    for (const v of ["My first stream", "Just Chatting", "cozy", "Live title", "About", "Tier 1", "Emotes"])
      expect(content).toContain(v);
    expect(untranslatedWords("My first stream · Just Chatting", { userContent: content })).toEqual([]);
  });
});

describe("catalog strings", () => {
  test("the es footer license is read from the es catalog and is not English", () => {
    const es = expectedFooterLicense("es");
    expect(es).toBe(webCatalogMessage("es", "core", "footer.license"));
    expect(es).not.toBe(webCatalogMessage("en", "core", "footer.license"));
  });

  test("en-XA is the English message pseudo-localized", () => {
    expect(expectedFooterLicense(PSEUDO_LOCALE)).toBe(
      pseudoLocalize(webCatalogMessage("en", "core", "footer.license")),
    );
    expect(untranslatedWords(expectedFooterLicense(PSEUDO_LOCALE))).toEqual([]);
  });

  test("a missing key is an error, not undefined", () => {
    expect(() => webCatalogMessage("en", "core", "no.such.key")).toThrow(/no "no.such.key"/);
  });

  test("webLocales lists the catalog languages, en and es included, never en-XA", () => {
    const tags = webLocales();
    expect(tags).toEqual(expect.arrayContaining(["en", "es"]));
    expect(tags).not.toContain(PSEUDO_LOCALE);
  });
});
