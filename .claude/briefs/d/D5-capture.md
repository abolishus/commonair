<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# D5-capture: the signed-in visual pass

You are implementing unit D5-capture for CommonAir (repo: /Users/joshe/Repos/bcon). Before you start,
read:

- AGENTS.md, which includes the design rules;
- `.claude/briefs/d/README.md`, including decision (c): how the user chose to sign in;
- the design review, especially "How it was done" and findings F21–F28, which were reviewed from
  code only.

Do not look outside the repository. This is **wave 1**. It is documentation only, on branch
`d/d5-capture`.

## Why

The November review could not sign in, so the studio, settings, moderation and admin pages were
judged from source. D5-studio fixes those pages in wave 3 and needs real screenshots to work from.
Several visual sign-offs are also still open in PROGRESS.md: W2 (`:369`, `:386-387`), N2
(`:430-431`), E6 (`:1603-1606`), E5 (`:1673-1675`), E4b (`:1737`) and E4a (`:1817`).

## You own (write only these)

- `docs/design/2026-11-review/signed-in/**` (new): the screenshots.
- `docs/design/2026-11-design-review.md`: a new section, "Addendum: signed-in pass". Do not edit
  the existing findings.

## Do this

1. **Sign in.**
   - Use the staging instance or the user's local seeded stack, as decision (c) says.
   - **Never type, print or store a password.** If the user signs in for you in the built-in
     browser pane, wait for them. Otherwise, write the checklist in step 3 for the user to
     capture themselves.
2. **Capture each surface**, in dark and light, at 1440×900 and 375×812, as these seeded roles:
   - `demo_streamer1`, a streamer with data: `/dashboard`, `/rehearse`, `/overlays`, `/interact`,
     `/bot`, `/chat`, `/captions`, `/content`, `/analytics`, `/revenue`, `/crew`, `/relays`,
     `/move`, `/import` and `/developer`;
   - `newbie`, empty everywhere: the same pages, for the empty states (F25);
   - a viewer: every `/settings/*` page, `/coop/membership` and the appeals page;
   - a moderator: `/admin/moderation`, the held queue and the jury;
   - an admin: every `/admin/*` page.

   Name the files `NN-<role>-<page>-<theme>-<width>.jpg`. Use JPEG at quality 80 or below, at
   most about 120 KB each, and keep the set under 25 MB.

3. **The checklist.** If the user captures, write the same list as a checklist in the addendum and
   stop there.
4. **Confirm or correct F21–F28.** For each finding, say "confirmed", "worse than described" or
   "not reproduced", with screenshot references. Add new findings as **F29 onward**, in the same
   shape as the review's.
5. **The open PROGRESS.md sign-offs.** For each one listed above, say which screenshots cover it.
   Recording the sign-off itself is the user's call. List them for the user; do not edit
   PROGRESS.md.

## Done means

- The screenshots are committed and the addendum is written. `reuse lint` passes: images are
  covered by `REUSE.toml`'s `**/*.jpg`.
- The final message says:
  - which findings are confirmed;
  - the new findings;
  - which PROGRESS sign-offs the screenshots can close.

  Run no checks beyond `vp fmt` and `reuse lint` on your files.
