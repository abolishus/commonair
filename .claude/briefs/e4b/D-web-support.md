<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **E4b unit D, web-support** for CommonAir (repo: /Users/joshe/Repos/bcon).
Read AGENTS.md, PLAN.md, docs/architecture.md and `.claude/briefs/e4b/_common.md` first, then
`docs/testing/e4b-selectors.md` in full, `packages/ui/README.md`, `packages/ui/DEVIATIONS.md`,
and the E4a design rules in `.claude/briefs/e4/_common.md` (they still apply to everything you
add in `packages/ui`). Do not look outside the repository.

## You own (write only these)

- apps/web: `src/components/support/**` (new), `src/lib/support.ts` (new; code-to-key maps typed
  as `MessageKey` are allowed there), `src/i18n/support.ts` (your message catalog, spread into
  `en.ts`), `src/routes/_app/$channel.tsx` (add the Support button; keep every e1–e3 id),
  `src/routes/_app/settings.subscriptions.tsx` (replace the placeholder), `src/chat/**` (render
  `op: "event"` frames), `tests/support*.test.ts(x)`, `tests/subscriptions*.test.ts(x)`,
  `tests/chat-events*.test.ts(x)`, and your rows in `tests/composition-ids.ts` and
  `tests/selectors-render.test.tsx`
- packages/ui: `src/blocks/media/chat-event.tsx` (new), `src/blocks/media/index.ts` (export it),
  `src/blocks/forms/option-card.tsx` and `src/blocks/forms/amount-field.tsx` (additive prop
  changes only), `src/blocks/forms/index.ts`, `stories/blocks/media/ChatEvent.stories.tsx`,
  the existing stories of the two form blocks, `tests/blocks/media/chat-event.test.tsx`, the
  existing tests of the two form blocks, and `stories/pages/Support.stories.tsx` (update it to the
  new props if useful)

Unit E owns the nav (`src/lib/nav.ts`, `src/components/site-chrome.tsx`, `_studio.tsx`, the
account-menu link to your page) and the other money pages in parallel. Do not edit
`tests/selectors.test.ts` or `tests/i18n.test.ts`; the head agent adds the e4b doc to them after
both web units merge.

## Contracts you must honor (read-only for you)

- `money.support`, `money.subscribe` (with `gift`), `money.tip`, `money.mySubscriptions`,
  `money.cancelSubscription` and their DTOs (`SupportInfo`, `CheckoutResult`, `Subscription`);
  `MONEY_LIMITS`, `MANUAL_REFERENCE_PATTERN`; the chat wire protocol `op: "event"` frame
  (`packages/contracts/src/chat.ts`) with the event payloads in `packages/contracts/src/events.ts`.
- The test ids in the spec's "Support dialog", "Chat" and "/settings/subscriptions" sections.
- The API is being built in parallel (unit A). Code against the contract types; your tests mock
  the oRPC client the way the existing web tests do.

## Build

1. **Support dialog** (Support board: `packages/ui/stories/pages/Support.stories.tsx`): an
   `AccentButton` `support-open` in the channel header actions next to Follow (not for the
   owner; signed out it links to `/signin`). The `Dialog` (`support-dialog`, a `Drawer` is not
   needed: the Dialog scrolls at 320 px) with `PageTabs` sub / gift / tip, `OptionGroup` tiers,
   `ChoiceToggle` gift presets + count input, recipient toggle + username field, `AmountField`
   for tips with presets, message `Textarea` with a character count, anonymous `Checkbox`,
   `BreakdownBar` split (creator vs co-op from `support.split`, per the chosen amount; no
   invented "processing" segment under the manual adapter), total, submit. Tabs disabled with a
   reason as in the spec. Load `money.support` when the dialog opens.
2. **Result**: `instructions` → replace the form with the instructions panel (reference with a
   copy `IconButton tooltip`, amount, the instructions text, a "Done" button);
   `redirect` → `window.location.assign(url)` (Stripe, later). Errors → `support-error` inline
   (and keep the form). The submit is disabled while in flight.
3. **`/settings/subscriptions`** (signed-in guard like `/relays`): a `DataTable` or `ItemGroup`
   of your subscriptions with `ChannelAvatar`, tier, status `StatusBadge`, period end
   `<RelativeTime>`, gifted marker, `subscription-cancel` with `ConfirmDialog`; `EmptyState`.
4. **Chat events**: render `op: "event"` frames for `channel.subscribe`,
   `channel.subscription.gift` and `channel.tip` as `chat-event` rows in the chat log, using a
   new `ChatEvent` composition in `packages/ui` (icon, accent tone, one line of text from props,
   optional amount via `<MoneyAmount>`, optional message body; `role="listitem"` semantics like
   `ChatMessage`; respects reduced motion). Event frames are not chat messages: they never count
   toward unread/pinning logic that assumes a message id; keep the existing log cap.
5. **packages/ui changes** (additive, backwards compatible, with stories + tests): `OptionGroup`
   items accept per-item `data-*` attributes (or an `itemProps` map) so `support-tier` rows can
   carry `data-tier`/`data-cents`; `AmountField` forwards `data-cents` (the parsed value) and an
   input test id. Keep the packages/ui source-policy test green.

## Tests you must add

- apps/web: dialog state logic (`src/lib/support.ts`: totals in cents, gift validation, tab
  availability from `SupportInfo`), SSR render of the dialog with every spec id present
  (`selectors-render.test.tsx` rows), chat event mapping (frame → row props, anonymous tip →
  empty `data-user`), subscriptions page states (empty, active, cancelling, gifted).
- packages/ui: `ChatEvent` behaviour + a11y + SSR/hydration, the new `OptionGroup`/`AmountField`
  props.

## Done means

See `_common.md` "Done means". Your packages: `apps/web` (`bun run test`, `tsc`, `vp build`) and
`packages/ui` (`bun run test`, `tsc`, `bun run build-storybook`, then delete
`storybook-static/`), lint/fmt on changed paths.
