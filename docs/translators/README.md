<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Translating CommonAir

Thank you for helping. CommonAir is a cooperative, community-owned live streaming platform, and
every viewer, streamer and member should be able to use it in their own language. You need no
programming knowledge: everything happens in a web editor.

| Page                                   | What it covers                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| This page                              | Where to translate, how your work reaches the platform, what not to translate |
| [message-format.md](message-format.md) | Placeholders, plurals, select and apostrophes, with examples                  |
| [style.md](style.md)                   | Tone and style for every language, then one section per language (Spanish)    |

## Where to translate

On Hosted Weblate: <https://hosted.weblate.org/projects/commonair/> (or the invitation page,
<https://hosted.weblate.org/engage/commonair/>).

1. Create a Weblate account. Your **full name** and **commit e-mail** (Profile → Account) are what
   appear in the project's history; you may choose Weblate's private address.
2. Open the project and accept the agreement: your translations are licensed AGPL-3.0-or-later like
   the code, you keep your copyright, and each save is committed with a `Signed-off-by` line in your
   name under the [Developer Certificate of Origin](https://developercertificate.org/). That line
   certifies you wrote the translation and may contribute it.
3. Pick your language. If it is not there, use **Start new translation** (the web app and design
   system components); email languages are added by a maintainer, so ask on the project's
   discussion page.

The project is split into **components**, one per area of the product:

- `web: …`: the web app, one component per area (`web: core` is navigation and the basics,
  `web: coop` the cooperative, `web: e7-dmca` copyright notices, and so on);
- `ui: ui`: buttons and labels shared by the design system (Close, Next page, …);
- `email: …`: the emails the platform sends, one component per group;
- `glossary`: the agreed terms (below).

Start with `web: core` and `ui: ui`: they are on every page.

## How your work reaches the platform

Weblate collects the day's translations and opens a pull request on GitHub. The project's automatic
checks run on it (every message must still parse and keep the English placeholders), a maintainer
looks it over and merges it, and the next release ships it. Until a string is translated, people see
the English one, so a partial translation is useful from day one.

**Spanish** was drafted in full before translators joined, and every Spanish string is marked
**Needs editing**: it is waiting for a person to read it, correct it if needed, and save it. Saving
a string, changed or not, marks it reviewed. The **Needs editing** filter shows what is left.

## The glossary

Each language has a glossary of agreed terms (stream, co-op, payout, moderator…). Weblate shows a
term's agreed translation beside the string while you work. Use it; if a term reads badly in
context, suggest a change on the glossary entry instead of using a different word in one place, so
the whole interface stays consistent.

## What not to translate

- **`{placeholders}`**: anything in braces, such as `{name}`, `{count}` or `{instance}`, is filled in
  by the platform. Keep it exactly as written (you may move it). See
  [message-format.md](message-format.md).
- **Brand and product names**: Hosted Weblate, Stripe, Discord, Twitch, OBS. The platform's own
  name is never in a string: it comes from `{instance}`, because every co-op runs its own instance
  under its own name.
- **Read-only strings**: four legal statements in `web: e7-dmca` (the sworn statements in a
  copyright notice and counter-notice) stay in English in every language. They are attestations a
  person signs under penalty of perjury under US law, and a translation would be a different,
  unreviewed statement. Weblate shows them as read-only.
- **Legal documents** (terms of service, privacy policy and so on) are not in Weblate; they stay in
  English until counsel decides otherwise. The interface around them is translated.
- **Key names**, the `prefix.area.name` identifiers you see beside each string.

## Getting help

Read the explanation shown beside a string for context. To ask what a string means, or to report a
mistake in the English, leave a comment on the string and choose the source string as its scope, so
it reaches the maintainers rather than only your language's translators.
