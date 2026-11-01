<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# The message format

CommonAir's messages use a small part of ICU MessageFormat, the format many projects share.
Weblate checks every translation against the English as you type (the "ICU MessageFormat" check),
and the project's automatic tests check it again before anything ships. If a message does not parse,
people see the English instead, so the checks are worth a second look.

The rule behind everything below: **translate the words, keep the structure.**

## Placeholders

Text in braces is filled in by the platform.

| English                   | Spanish                           |
| ------------------------- | --------------------------------- |
| `Welcome to {name}`       | `Te damos la bienvenida a {name}` |
| `Account menu for {name}` | `Menú de la cuenta de {name}`     |

- Keep the name inside the braces exactly as in English: `{name}` stays `{name}`, never `{nombre}`.
- You may move a placeholder to wherever your grammar needs it, and drop none.
- Do not add placeholders the English does not have.
- Values arrive already formatted for your language: dates, amounts of money, percentages and
  durations are ready-made text. Never write `{amount, number}` or `{date, date}`: typed arguments
  are not supported and the tests reject them.

## Plurals

A plural chooses a phrase by a number. `#` is the number, formatted for your language (12,345 in
English, 12.345 in Spanish and German).

```text
English: {count, plural, one {# follower} other {# followers}}
Spanish: {count, plural, one {# seguidor} other {# seguidores}}
```

- Keep `{count, plural,` (the argument name and the word `plural`) as it is; translate only the
  text inside each `{…}` branch.
- **Use your own language's categories**, not English's. English has `one` and `other`; Polish
  needs `one`, `few`, `many` and `other`; Japanese only `other`; Arabic `zero`, `one`, `two`, `few`,
  `many` and `other`. Weblate's plural information for your language, or the
  [CLDR plural rules](https://www.unicode.org/cldr/charts/latest/supplemental/language_plural_rules.html),
  list them. `other` is always required.
- **Keep exact matches** like `=0` when the English has them: `=0 {No votes}` is the text for exactly
  zero and wins over the categories.

  ```text
  English: {count, plural, =0 {No votes} one {# vote in total} other {# votes in total}}
  Spanish: {count, plural, =0 {Sin votos} one {# voto en total} other {# votos en total}}
  ```

- A branch may hold placeholders, and may leave out `#` if your sentence reads better without it
  (`one {a subscription}` is fine).
- **Offset**: `{n, plural, offset:1 =1 {{host}} other {{host} and # others}}` subtracts 1 before
  `#` is shown. Keep `offset:1` exactly.

## Select

A select chooses a phrase by a word. Keep the selector words (`admin`, `other`, …) in English:
they are values from the code, not text.

```text
English: {role, select, admin {Admin} other {Member}}
Spanish: {role, select, admin {Administración} other {Miembro}}
```

`other` is required. Languages that inflect for gender may need the select's branches to differ
more than in English; that is fine as long as the selector words stay.

## Ordinals

`selectordinal` picks a phrase for 1st, 2nd, 3rd… Use your language's ordinal categories (Spanish
has only `other`):

```text
English: {n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}
Spanish: {n, selectordinal, other {#.º}}
```

## Apostrophes and literal braces

- A single apostrophe is ordinary text: `{name}'s channel`, `l'émission`, `can't` all work.
- Two apostrophes `''` show as one; you rarely need this.
- An apostrophe before a brace starts quoting: `'{literal}'` shows `{literal}` instead of a
  placeholder. Avoid it unless the English does the same.
- Typographic apostrophes (`’`) are always plain text, and are the better choice where your
  language uses them.

## When the check complains

| Weblate says                 | Usually means                                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| missing placeholder          | a `{name}` was dropped or renamed                                                                                                       |
| extra placeholder            | a `{…}` the English lacks, often a translated placeholder name                                                                          |
| syntax error                 | an unbalanced `{` or `}`, or a `plural` branch without braces                                                                           |
| type mismatch                | `{n, number}` or similar, or `plural` turned into `select`                                                                              |
| sub-message selectors differ | your language's plural categories differ from English: correct for plurals, dismiss it; for a `select`, keep the English selector words |
