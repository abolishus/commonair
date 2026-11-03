<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# D2-chat: full-height chat with a pinned strip for predictions, polls and giveaways

You are implementing unit D2-chat for CommonAir (repo: /Users/joshe/Repos/bcon). Before you start,
read:

- AGENTS.md;
- `.claude/briefs/d/README.md` and `D0-contract-step.md`;
- `.claude/briefs/_done-means.md`;
- the design review, finding **F6**, with screenshots 03, 04, 06, 08 and 10;
- B8-web's merged prediction-card changes (`.claude/briefs/b8/B8-web.md` §3);
- the W1 Calm Chat brief, `.claude/briefs/w1/W1-calm-chat.md`. Its behaviours must survive.

Do not look outside the repository. This is **wave 2**: work on branch `d/d2-chat`, cut from the
sha with D4 and batch 8 merged.

## You own (write only these)

- `apps/web/src/chat/**`.
- The `d2-chat` namespace. Move keys out of `e8-viewer`, `w3-predictions` or `w3-giveaways` only if
  a string changes.
- `apps/web/tests/d2-chat*.test.tsx` and `harness/src/d/d2-chat.ts`.

**Read-only:** `$channel.tsx`. The fixed `h-112 lg:h-160` at `:153` is D2-channel's to remove;
agree through the orchestrator that it becomes a `className` you control, or that D2-channel
applies your exported `CHAT_COLUMN_CLASS`. Also read-only: `player/**`, contracts, services.

## Build

1. **Full height.**
   - On `lg`, the chat column is sticky, `100svh` minus the header, and fills the column beside
     the player.
   - Below `lg`, it keeps a bounded height under the player.
   - In theatre mode (D2-player's `useTheatre()`), it spans the theatre height.
2. **The pinned strip.**
   - Predictions, polls, giveaways and goals collapse into one line at the top of the log
     (`chat-pinned-strip`): an icon, a short label, and the state ("Open · 2:31 left", "Locked",
     "Won by …").
   - When several are active, show the highest priority (an open prediction, then a poll, then a
     giveaway, then a goal), with a "+N" chip that cycles or expands.
   - Expanding opens the existing full card in a `Popover`, or inline, pushing the log down.
     The full cards keep their behaviour, including B8-web's grace-window betting.
   - The strip is keyboard reachable and announces a state change once, politely. It never
     announces timer ticks.
   - Dismissing it hides that item for this tab until its state changes.
3. **Offline and gated states.**
   - Replace "No messages yet" in offline and 18+-gated panels with an `<EmptyState>`: "Chat
     opens when <name> goes live", with the last message time if the API gives it.
   - Don't render an empty log frame in those states.
4. **The input row.** Keep the existing controls. If the channel has points (E8), show the
   balance as a compact chip in the input row, as Twitch does, using data already in the chat
   state. Fetch nothing new.

## Tests you must add

- `d2-chat-strip.test.tsx`: priority order, "+N", expand and collapse, dismissal per tab that
  returns when the state changes, the single announcement, and grace-window betting still works
  from the expanded card.
- `d2-chat-layout.test.tsx`: the column class at `lg`, below `lg`, and in theatre.
- `d2-chat-empty.test.tsx`: offline and gated states.
- The existing chat, Calm Chat, interact and replay tests pass unchanged.
- `harness/src/d/d2-chat.ts`, on the seeded stack: `demo_streamer1`, which has an open prediction
  and a giveaway, shows `chat-pinned-strip`, and expanding it shows the prediction card.

## Done means

- The `_done-means.md` checks pass.
- The user's visual checklist, in both themes:
  - `/demo_streamer1` at 1440×900, with chat reaching the bottom of the viewport and several
    lines visible (compare 03 and 04);
  - the strip with two items;
  - an offline channel (compare 10);
  - the 18+ gate (compare 08);
  - 375 px.
