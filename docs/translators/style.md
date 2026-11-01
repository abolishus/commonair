<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Style

General rules first, for every language; then one section per language with its own decisions. A
language team that settles a rule adds it to its section by pull request, or asks a maintainer to.

## Every language

- **One variant per language** where people can read it everywhere: a neutral form that speakers in
  every region understand, no regional slang. A regional variant (`pt-BR`, `es-MX`) is a separate
  language only when the neutral one is not enough.
- **Talk to the person** the way your language's software usually does: informal where that is
  normal, formal where that is expected. Pick one and keep it across the whole product.
- **Sentence case**, like the English: capitalise the first word and proper names only, also on
  buttons and headings, unless your language's rules say otherwise.
- **Inclusive without symbols**: prefer neutral wording ("the moderation team", "people watching")
  to gendered forms; do not use `@`, `x`, `*` or similar endings, which screen readers read badly.
- **Short where it shows**: buttons, labels, tabs and menu items have little room, and many languages
  run 20–40% longer than English. Prefer the shorter natural phrasing; full sentences belong in
  descriptions and help text.
- **Consistent terms**: use the glossary. The same English word means the same thing everywhere in
  the product, so it gets the same translation.
- **Money, legal and safety text**: translate the meaning exactly and do not soften or strengthen
  it. If the English is unclear, ask in a comment before guessing.
- **Numbers, dates and amounts** come pre-formatted (see [message-format.md](message-format.md));
  in examples you write yourself, follow your language's conventions.
- **Do not translate** placeholders, brand names, read-only legal statements or key names
  ([README.md](README.md#what-not-to-translate)).

## Spanish (`es`)

Decided in batch 5 (2026-10-31); the full term list is the
[Spanish glossary](../maintainers/translation-glossary-es.csv), shown in Weblate as you translate.

- **One `es` for all regions**: neutral Latin American Spanish that reads naturally in Spain. No
  `vosotros`, no regional slang.
- Address the reader as **tú** ("Inicia sesión para seguir este canal").
- **Sentence case**, like the English.
- **Inclusive without symbols**: "el equipo de moderación", "quien modera", "las personas que ven";
  never `@`, `x` or `-e` endings. Actors in the interface are teams or roles: "el equipo de
  moderación", "la administración", "la tesorería".
- **Plurals**: write `one` and `other`, and keep any `=0`/`=1` from the English. Do not write `many`
  (Spanish uses it only for exact millions, and `other` is correct there too).
- **Length**: Spanish runs about 20–30% longer; choose the shorter natural phrase for buttons and
  labels.
- **Numbers in examples**: decimal comma (5,00; 12,50); four-digit numbers have no group separator
  (8000). Months are capitalised in labels; a month label reads "{month} de {year}".
- **Retry**: "Reintentar" on buttons, "Inténtalo de nuevo." in sentences.
- **Unsubscribe** (from email) is "darse de baja", never "cancelar la suscripción", which is the paid
  subscription.
- **Offline** (a channel not streaming) is "no está en vivo" or "fuera del aire"; "sin conexión" only
  for a network or a relay.
- Keep in English: streamer, chat, clip, raid, webhook, token, bot, relay, overlay (the last two with
  a gloss the first time in a help text: "relay (nodo de retransmisión)", "overlay
  (superposición)").
