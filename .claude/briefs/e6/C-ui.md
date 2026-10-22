<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Unit C: `packages/ui` compositions for E6

You are implementing unit C of slice E6 for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md (design rules and house primitives), `.claude/briefs/e6/_common.md` and
`docs/testing/e6-selectors.md` (Routes and Test ids) first. Do not look outside the repository.

## You own (write only these)

- `packages/ui/src/**`, `packages/ui/stories/**`, `packages/ui/tests/**`

## Contracts you must honor (read-only for you)

The spec's test ids (every composition renders them, or passes them through props), the entity
shapes in `packages/contracts` (`AlertConfig`, `AlertTemplate`, `OverlayTokenStatus`,
`OverlayAlert`, `ExportJob`, `DeletionRequest`, `Vod`, `Clip`, the simulcast target shape).
Components are presentational: data and callbacks come in through props; strings come in as
props or through the existing i18n pattern used by other compositions (check how the co-op
boards do it).

## Build

Compositions with stories (default, light, 320 px) and tests, following the existing stories
(`stories/pages/Overlays.stories.tsx`, `Content.stories.tsx`, `Settings.stories.tsx`,
`StreamSetup.stories.tsx`) and turning them into reusable blocks:

1. **Simulcast panel** (`blocks/…`): target list (status badge, enabled switch, last error code,
   remove with `ConfirmDialog`), add form (name, platform select, URL, write-only key), the
   empty state, the 5-target cap, inline error with `data-reason`.
2. **Overlays board**: per-type alert config card (enabled, message with variable hints, min
   amount via `AmountField`, duration, animation, save, test), `AlertPreview` reuse, the token
   panel (status with expiry via `<RelativeTime>`, expiry select with quick picks `none 1d 7d 30d
   90d 6mo date` and a date-time input for `date`, create/rotate with `ConfirmDialog` when one is
   active, the once-shown URL in `CopyField`, revoke with `ConfirmDialog`).
3. **Overlay alert view** for OBS: transparent background, no chrome, one alert at a time with
   `fade`/`slide`/`none`, `prefers-reduced-motion` → none, large legible text with an outline for
   any stream background, root `data-state`. Pure view: the queue logic can live here as a hook
   (`useAlertQueue`: de-dup by id, one at a time for `durationMs`) with unit tests.
4. **Content board**: VOD and clip tabs, rows with title edit, visibility select, save, delete
   (`ConfirmDialog`), `<EmptyState>`, skeletons.
5. **Privacy board**: export panel (request per kind with cooldown-disabled state and its reason,
   rows with status badge, size, expiry and a download link while ready) and deletion panel
   (request with `ConfirmDialog` explaining what is kept, scheduled date, cancel).

Colors only via tokens, Hugeicons, Rubik, Base UI components, accessible (labels, focus,
keyboard), responsive to 320 px. Update the page stories to use the new blocks.

## Tests you must add

Unit/component tests for each block (test ids present, callbacks fired, disabled states, the
alert queue hook's de-dup and timing with fake timers, the expiry select producing `null` /
an instant for each choice) and the source-policy test still passing.

## Done means

As in `_common.md`. Run only `packages/ui` tests you added or touched, `bunx tsc -p packages/ui
--noEmit`, lint and fmt of your paths. Storybook builds and visual checks are the user's.
