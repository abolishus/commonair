<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# D2-player: one control bar with fullscreen, theatre, PiP, settings and shortcuts

You are implementing unit D2-player for CommonAir (repo: /Users/joshe/Repos/bcon). Before you
start, read:

- AGENTS.md, PLAN.md (3A at `:88` promises theatre, PiP and shortcuts) and docs/architecture.md;
- `.claude/briefs/d/README.md` (decision (b)) and `D0-contract-step.md`;
- `.claude/briefs/_done-means.md`;
- the design review, findings **F3 and F5**, with screenshots 03, 07, 12 and 13;
- the W1 data-mode brief `.claude/briefs/w1/W1-data-mode.md`. The feature stays; only its
  placement changes.
- B8-player's merged DVR and watch-room work.

Do not look outside the repository. This is **wave 2**: work on branch `d/d2-player`, cut from the
sha with D4 and batch 8 merged.

## You own (write only these)

- `apps/web/src/player/**`, except `player/p2p/**`, and except the media clock and heartbeat
  semantics. You may restyle `dvr-controls.tsx` into the new bar, but the DVR and watch-room
  behaviour that B8-player built must stay byte-for-byte in effect, and its tests must keep
  passing unchanged.
- `packages/ui/src/blocks/media/player-chrome.tsx` and its stories.
- `apps/web/src/components/vod-watch/vod-player.tsx`: the control bar only.
- The `d2-player` namespace, and `w1-data-mode` for moving its keys.
- `apps/web/tests/d2-player*.test.tsx` and `harness/src/d/d2-player.ts`.

**Read-only:** `$channel.tsx` (D2-channel places you), `chat/**`, `player/p2p/**` and
`packages/contracts/**`.

## Build

1. **One control bar (F3)** for live, DVR and VOD, built on `PlayerChrome` and `PlayerControl`:
   - play and pause;
   - volume: mute plus a `Slider`, revealed on hover or focus, and always on touch;
   - the live edge button (live and DVR), or elapsed / total (VOD);
   - captions;
   - settings: a `Popover` or `DropdownMenu`;
   - PiP;
   - theatre (not in embeds);
   - fullscreen.

   The bar shows on hover, on focus within the player, and on tap. It hides after 3 s of
   inactivity during playback, never while paused or while focus is inside it. It stays visible
   under `prefers-reduced-motion`, with no fade.

2. **The settings menu (F5).**
   - It holds quality (from the source's renditions, with "Auto"), Data saver (moved from the
     permanent `DataModePanel` card at `player/player.tsx:355`), and speed on VOD.
   - While a data budget is on, a small "Data saver · <level>" chip shows in the bar
     (`player-data-saver-chip`).
   - The first-run explanation becomes a one-time hint `Popover` anchored to the settings button.
     Dismissal is stored like the other per-tab hints.
3. **Fullscreen and PiP.**
   - Use the standard Fullscreen API on the player container, so the bar and captions stay
     visible, and the video element's PiP.
   - Hide a button when the browser lacks support; never show a disabled one.
   - iOS Safari: fall back to `webkitEnterFullscreen` on the video element for fullscreen.
4. **Theatre.** Export `useTheatre()` from `player/theatre.ts`: a context with
   `{ theatre, setTheatre }`, stored per tab. D2-channel lays the page out from it. The `t` key
   toggles it.
5. **Shortcuts**, active only while focus is in the player or on the page body, never in text
   inputs or chat:
   - `space` and `k`: play or pause;
   - `m`: mute;
   - `f`: fullscreen;
   - `t`: theatre;
   - `c`: captions;
   - left and right arrows: ±5 s on DVR and VOD;
   - up and down arrows: volume;
   - `?`: a `Dialog` listing the shortcuts (`player-shortcuts-dialog`).

   Fold the existing DVR keyboard handling into this one map, without changing its keys.

## Tests you must add

- `d2-player-bar.test.tsx`: show and hide timing (fake timers), focus keeps the bar, reduced
  motion, and live vs VOD controls.
- `d2-player-settings.test.tsx`: quality options, Data saver in the menu, the chip, the one-time
  hint.
- `d2-player-keys.test.tsx`: every shortcut; none fire in an input or in chat; the DVR keys are
  unchanged; the `?` dialog.
- `d2-player-support.test.tsx`: unsupported Fullscreen and PiP hide their buttons; the iOS
  fallback path.
- The existing W1 data-mode, DVR and watch-room tests pass unchanged.
- Storybook for `PlayerChrome`: live, DVR, VOD, the data saver chip, 320 px, both themes.
- `harness/src/d/d2-player.ts`, on the seeded stack:
  - `player-controls` appears on hover on `/demo_streamer1`;
  - `player-settings` contains the data saver;
  - `t` toggles theatre.

## Done means

- The `_done-means.md` checks pass, including `vp build`.
- The user's visual checklist:
  - live, DVR and VOD bars in both themes (compare 07 and 12);
  - fullscreen and PiP in Chromium, Firefox and Safari;
  - theatre mode;
  - the keyboard-only shortcuts;
  - 375 px (compare 13);
  - the data saver chip.
