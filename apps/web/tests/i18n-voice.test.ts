// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The voice guide's binding rules (`docs/design/voice.md`), checked over every catalog string so
 * they hold without relying on reviewers' memory: the honesty rules, the glossary's banned words
 * and the one error pattern ("{section} didn't load" plus Retry).
 */
import { readNamespaces } from "@commonair/i18n/catalog";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const LOCALES = new URL("../src/i18n/locales/", import.meta.url).pathname;
const UI = new URL("../../../packages/ui/src/locales/", import.meta.url).pathname;

function messages(lang: string): Array<readonly [key: string, message: string]> {
  const web = readNamespaces(LOCALES)
    .filter((ns) => ns.lang === lang)
    .flatMap((ns) => ns.entries);
  const ui = Object.entries(JSON.parse(readFileSync(join(UI, lang, "ui.json"), "utf8")) as Record<string, string>);
  return [...web, ...ui];
}

const en = messages("en");
const es = messages("es");

/**
 * `.retry` keys that are not a Retry button: the header's session placeholder is an icon button,
 * and its accessible name says in full what it retries.
 */
const NOT_A_RETRY_BUTTON = new Set(["fixSession.session.retry"]);
const retryButtons = (list: typeof en) => list.filter(([k]) => k.endsWith(".retry") && !NOT_A_RETRY_BUTTON.has(k));

/** The keys whose message matches `re`, so a failure names every offender at once. */
function offenders(list: typeof en, re: RegExp): string[] {
  return list.filter(([, m]) => re.test(m)).map(([k, m]) => `${k}: ${m}`);
}

describe("the voice guide (English)", () => {
  it("has the catalogs to check", () => {
    expect(en.length).toBeGreaterThan(4000);
    expect(es.length).toBe(en.length);
  });

  it.each([
    ["dead-end errors", /something went wrong/i],
    ["full-page reloads as the next step", /\breload (the page )?(to|and) (try|retry)/i],
    ["errors in the old 'could not be loaded' shape", /could not be loaded|did not load|could not load\b/i],
    ["gambling words for predictions", /\b(bet|bets|betting|wager|gamble|gambling)\b/i],
    ["'member' meaning an account", /already a member/i],
    ["claims we can't back (honesty rules)", /highest share|more than anyone|no thresholds?\b|get paid instantly/i],
    ["surplus promises (honesty rules)", /share in the profits|earn dividends|your share of the surplus/i],
    ["a hard-coded creator share", /\b90 ?%/],
    ["system words for saved streams", /\bVODs?\b|past broadcasts?/i],
    ["a second name for the studio", /creator dashboard|go to your dashboard/i],
    ["donations (the word is tip or support)", /\bdonat(e|es|ion|ions)\b/i],
  ])("never uses %s", (_what, re) => {
    expect(offenders(en, re)).toEqual([]);
  });

  it("labels every retry button Retry, never Try again", () => {
    expect(
      retryButtons(en)
        .filter(([, m]) => m !== "Retry")
        .map(([k]) => k),
    ).toEqual([]);
    expect(offenders(en, /^try again\.?$/i)).toEqual([]);
  });

  it("says Try again in two wordings only: now, or in a few minutes", () => {
    // "We will try again later" is the app retrying on its own, not an instruction.
    const vague = /(?<!will )try again (later|soon|in a moment|in a little while)|please try again/i;
    expect(offenders(en, vague)).toEqual([]);
  });

  it("never talks about prediction points like money (honesty rules)", () => {
    const predictions = en.filter(([k]) => /^(chatPrediction|fairPrediction|interact\.prediction)\./.test(k));
    expect(predictions.length).toBeGreaterThan(30);
    expect(offenders(predictions, /paid out|refund|cash|\bwin big\b|jackpot/i)).toEqual([]);
  });

  it("keeps 'member' out of watch rooms (it means a co-op member)", () => {
    const rooms = en.filter(([k]) => k.startsWith("watchRooms."));
    expect(offenders(rooms, /\bmembers?\b/i)).toEqual([]);
  });

  it("names the channel to viewers, not 'the streamer' (the co-op's streamer class is fine)", () => {
    expect(offenders(en, /\b(the|its|their) streamer\b(?! class)/i)).toEqual([]);
  });
});

describe("the voice guide (Spanish follows English)", () => {
  it.each([
    ["gambling words for predictions", /apuest|apost|\bbote\b/i],
    ["dead-end errors", /algo salió mal/i],
    ["a second name for the studio", /panel de creador/i],
  ])("never uses %s", (_what, re) => {
    expect(offenders(es, re)).toEqual([]);
  });

  it("labels every retry button Reintentar", () => {
    expect(
      retryButtons(es)
        .filter(([, m]) => m !== "Reintentar")
        .map(([k]) => k),
    ).toEqual([]);
  });
});
