<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N2-es-a, N2-es-b, N2-es-c: the Spanish web catalogs

You are implementing one of three Spanish catalog units for CommonAir (repo: this checkout); the
orchestrator tells you which (a, b or c). Read AGENTS.md, [ADR 0029](../../../docs/decisions/0029-i18n.md)
decisions 2 and 6, [`batch5/README.md`](../batch5/README.md) (decisions (a), (h), (m) and **the
Spanish style and glossary**, which bind you) and `apps/web/src/i18n/README.md` ("The message
format"). Do not look outside the repository. Wave 1, branch `n2/es-<letter>`.

## You own (write only these)

| Unit    | Files (`apps/web/src/i18n/locales/es/…`)                                                                                                                                                                                                                                                                           | Strings |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| N2-es-a | `coop.json`, `safety.json`, `ops.json`, `e7-dmca.json`                                                                                                                                                                                                                                                             | ~1,090  |
| N2-es-b | `core.json`, `money.json`, `e8-studio.json`, `e8-viewer.json`, `support.json`                                                                                                                                                                                                                                      | ~1,016  |
| N2-es-c | `e9-console.json`, `e9-consent.json`, `e7-admin.json`, `w1-fraud.json`, `w1-breakdown.json`, `n1-inbox.json`, `w1-watch-gate.json`, `w1-calm-chat.json`, `e7-appeals.json`, `n1-discord.json`, `w1-data-mode.json`, `n2-consent.json`, `p2p.json`, `n1-pwa.json`, `n1-email.json`, `e7-chat.json`, `e7-legal.json` | ~910    |

Each file mirrors `locales/en/<same name>.json` at the wave-1 base sha: the same keys in the same
order, every key translated. Nothing else changes (no `keys/*.gen.ts` change: keys come from English).

## Contracts you must honor (read-only for you)

- The English catalogs (`locales/en/*.json`) — never edit them. If an English string is wrong or
  ambiguous, translate the evident meaning and list it as a contract request with a proposed fix.
- The message format: keep every `{placeholder}` name, every ICU `plural`/`select`/`selectordinal`
  with the same argument and case names, `#`, `offset:`, `=N` cases, and apostrophe quoting. The
  contract step's parity check (`checkCatalog`) fails on any argument difference.
- Read the code that uses a key (`grep -rn '"<key>"' apps/web/src`) whenever the English alone does
  not tell you whether it is a button, a heading, an accessible name, or a sentence fragment, and
  what `{placeholders}` hold (a number already formatted, a name, a link label).

## Build

1. Translate every key of your files into Spanish per the style rules and glossary. Buttons and
   menu items are infinitives or short imperatives consistently within a namespace (prefer the
   infinitive for buttons: "Guardar", "Cancelar"); headings are sentence case; accessible names
   are full phrases.
2. **Plurals**: write `one` and `other` (and keep any `=0`, `=1` cases English has). Spanish
   also has `many` (exact millions, `1000000`), which the formatter resolves to `other` when absent
   (`packages/i18n/src/format.ts`), and `other` is correct Spanish there: do not write `many`.
3. **N2-es-a only, decision (h)**: the DMCA notice and counter-notice **sworn statements** in
   `e7-dmca` (the statutory attestations under 17 U.S.C. § 512(c)(3)(A) and § 512(g)(3): good-faith
   belief, accuracy, under penalty of perjury, consent to jurisdiction) keep their **English text
   verbatim** in `es`. Translate the surrounding labels and help. List those keys exactly in your
   final message (N2-weblate marks them read-only).
4. Leave legal terms of art in other namespaces translated normally, but conservative and literal.
5. No machine-translation service and no network: you translate.

## Tests you must add

None new: the contract step's checks are your tests. Run
`cd apps/web && bun run i18n:check && bun --bun vp test run tests/i18n.test.ts` and, for coverage of
your files, a one-off `bun -e` using `coverage` from `@commonair/i18n/catalog` (paste the numbers:
100% for each of your namespaces). Also render-check a sample: `bun --bun vp test run tests/i18n-runtime.test.ts`.

## Done means

All your files at 100% with parity clean, `vp fmt` on them (JSON formatting), `reuse lint`.
`git status` shows only your files. Commit with `git commit -s`
(`feat(i18n): Spanish catalogs for <namespaces>`). Final message: per-namespace counts, branch +
sha, glossary terms you added (English → Spanish), English strings you think are wrong (contract
requests), the e7-dmca verbatim keys (es-a), and anything left undone.
