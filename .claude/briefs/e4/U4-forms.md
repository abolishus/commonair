<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **E4a U4 — form and settings blocks** for CommonAir (repo:
/Users/joshe/Repos/bcon). Read AGENTS.md ("Design rules (web)", "House primitives", "Code style":
money is integer cents), PLAN.md (E4a row), `packages/ui/README.md`, `packages/ui/DEVIATIONS.md`,
then `.claude/briefs/e4/_common.md` and `.claude/briefs/e4/_compositions.md` (both are part of this
brief). Do not look outside the repository. You work in your own git worktree: run
`git merge main --no-edit` first, then `bun install` if `node_modules` is missing. Other units build
shells/headers (U2), data blocks (U3) and media/player/chat blocks (U5) in parallel; do not build
those.

Canvas: <https://claude.ai/artifact/Ve5J5XjRZV42eRE2cdReVd>. Boards you cover: **Settings**
(profile card with avatar upload, display name + username prefix, bio with counter, accent picker,
sign-in methods rows, notification switch matrix, data export / delete rows), **SignIn** (sign-up
form, password strength, date-of-birth fieldset, ALTCHA row, legal checkbox, alternate methods,
"what you get" card), **StreamSetup** (protocol toggle, copyable server URL, stream key with
show/copy/reset, selects, quality table switches (table itself is U3's DataTable — you provide the
switch cell pattern), simulcast targets rows with switches, recording switch rows), **StreamManager**
(stream info card: title with counter, category/language selects, tags chips input, mature switch,
Update), **Support** (sub tiers as option cards, gift count toggle + recipient select, tip amount
presets + custom amount with currency addons, message textarea + hint, payment method select, CTA),
**Proposal** (vote option cards + confirm, comment composer), **Overlays** (browser-source URL copy +
regenerate + test, tip alert settings form, layout toggle), **ChatBot** (chat modes switch rows with
trailing selects), **Developer** (client id/secret copy/rotate, scopes), **Clip** (title field with
counter, share link copy, embed code block), **Community** (mod note textarea), **TrustSafety**
(decision toggle, duration/template selects, internal note, card footer actions), **Revenue**
(payout method tiles), **Transparency** (formula code block). Condensed copies:
`.claude/briefs/e4/boards/<Board>.html`, sample data in `.claude/briefs/e4/boards/data/`.

## You own (write only these)

- `packages/ui/src/blocks/forms/**`, `packages/ui/stories/forms/**`, `packages/ui/tests/forms/**`

## Contracts you must honor (read-only for you)

- `packages/ui/src/components/**` (U1: `field`, `input`, `input-group`, `textarea`, `select`,
  `combobox`, `checkbox`, `switch`, `radio-group`, `toggle-group`, `button`, `card`, `item`,
  `progress`, `alert`, `collapsible`), house primitives (`IconButton`, `ConfirmDialog`,
  `StatusBadge`, `AccentButton`, `ChannelAvatar`, `MoneyAmount`/`formatMoney`, `toast`),
  `ACCENTS` from `@commonair/contracts/shapes`, `minorUnits()` from `@commonair/contracts/currency`.
- apps/web keeps these ids on the fields it renders through your blocks: `signup-*`, `signin-*`,
  `form-error`, `stream-key`, `stream-key-copy`, `stream-key-prefix`, `stream-key-rotate`,
  `stream-server-url`, `relay-create-name`, `relay-create-submit`, `relay-token`,
  `relay-run-command`: every input, button and value element you render must forward `data-*`
  props (via explicit `inputProps`/`buttonProps`/`valueProps` or spreading).

## Build

1. **`FormSection`** (a.k.a. SettingsSection): `Card` with `title`, `description?`, header
   `action?`, body of `Field`s (`FieldGroup`), footer `actions` (Cancel ghost + Save), `onSubmit`
   when it is a form (renders `<form>`), `aria-labelledby` wired; `variant: card | plain`.
2. **`SwitchField`**: `Field orientation="horizontal"` with `Switch`, label, description, optional
   trailing control slot (ChatBot slow-mode delay `Select`), disabled + "coming later" state.
3. **`OptionCard`** + **`OptionGroup`**: the shadcn "choice card" pattern (`RadioGroup` + `Field`
   - `FieldLabel` wrapping each item): title, description/perks, trailing value (price via
     `MoneyAmount`), selected state, keyboard arrows; used for sub tiers and vote choices; also a
     `multiple` mode on `Checkbox` (if the boards need it; document).
4. **`CopyField`**: read-only value in `InputGroup` (`InputGroupInput readOnly`), `Copy` button
   (clipboard + `toast.success(copiedLabel)`; failure toast), optional `secret` mode (masked with
   Show/Hide toggle), optional extra actions (`Reset key`/`Rotate`/`Regenerate` through
   `ConfirmDialog` when destructive), `hint`. Covers server URL, stream key, client id/secret,
   overlay URL, clip link, relay token.
5. **`CodeBlock`**: preformatted code (embed snippet, patronage formula, run command) in a bordered
   block with a copy `IconButton`; wraps or scrolls (prop) at 320 px.
6. **`CharacterCountField`**: `Input`/`Textarea` with a live "n / max" counter in
   `FieldDescription` (`aria-live="polite"` only when near the limit), `maxLength` enforced.
7. **`AmountField`**: preset amounts `ToggleGroup` + custom amount `InputGroup` with currency
   symbol prefix and ISO code suffix; value in **integer minor units** using `minorUnits(currency)`,
   parsing per locale; min/max validation via `FieldError`.
8. **`ChoiceToggle`**: labelled single-select `ToggleGroup` inside a `Field` (protocol, gift count,
   decision, layout, alert-to-preview) — the one way a `seg` with a label is rendered.
9. **`TagsField`**: shadcn `Combobox` multiple with chips (StreamManager tags), add/remove by
   keyboard, max count.
10. **`AccentPicker`**: `RadioGroup` (or `ToggleGroup`) of the 12 `ACCENTS` as swatches
    (`bg-channel-accent` under `data-accent`), labels from a `labels` prop, visible focus.
11. **`ActionRow`**: `Item variant="outline"`: icon/media, title + `StatusBadge`, description,
    trailing action button(s); `tone: default | destructive`. Covers sign-in methods, export/delete
    rows, payout method and tax tiles, simulcast target rows (with trailing `Switch` + status).
12. **`PasswordField`** with optional strength meter (`Progress` + text) and show/hide
    `InputGroupButton`; **`DateOfBirthField`** (`FieldSet` + three `Select`s, locale month names via
    `Intl`, value as ISO date string, invalid date error).
13. **`SwitchMatrix`**: rows × channels of labelled `Switch`es (Settings notifications) built on
    shadcn `Table` (each switch's accessible name = row + column), stacks at 320 px.
14. **`CommentComposer`**: `Textarea` + hint + submit (Proposal discussion, mod note) on `Field`.

Each block is controlled (value/onValueChange) or uncontrolled (defaultValue) like the shadcn parts
it wraps, and shows `FieldError` from a string or `{ message }[]` (the `field` deviation).

## Tests you must add

- Behaviour: copy success/failure toasts (mock `navigator.clipboard`), secret show/hide,
  destructive action confirms, counter + maxLength, AmountField parsing (USD, JPY 0 digits, KWD 3
  digits, comma-decimal locale, negatives rejected, min/max), OptionGroup arrow keys + selection,
  TagsField add/remove by keyboard and max, DateOfBirthField invalid dates (Feb 30) and month names
  per locale, SwitchMatrix accessible names, FormSection submit, `data-*` forwarding on inputs and
  buttons. SSR + hydration without warnings for every block.

## Stories

One story file per block under `stories/forms/` with fixtures from the boards (Settings profile,
StreamSetup ingest, Support tiers/tip, Proposal vote, Overlays tip alert …), each with `Light` and
`Mobile320` stories, plus error/disabled states.

## Done means

Per `_common.md` "Done means". Also list every export for `src/blocks/forms/index.ts` (you write it).
