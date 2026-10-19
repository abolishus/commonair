// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * CommonAir house primitives. Apps use these instead of ad-hoc markup (see the
 * "House primitives: use X, not Y" table in AGENTS.md). The shadcn building
 * blocks are under `@commonair/ui/components/*`, notifications under
 * `@commonair/ui/toast`, tokens in `@commonair/ui/globals.css`.
 */
export { LocaleProvider, useLocale, useUiMessages, type LocaleProviderProps } from "./lib/locale.tsx";
export { NowProvider, useRequestNow, type NowProviderProps } from "./lib/now.tsx";
export { enMessages, type UiMessages, type DiscoveryReason } from "./lib/messages.ts";
export {
  formatMoney,
  formatCompactNumber,
  formatNumber,
  formatRelativeTime,
  formatDateTime,
  getInitial,
  minorDigits,
  type FormatMoneyOptions,
} from "./lib/format.ts";

export { StreamCard, type StreamCardProps, type StreamCardData } from "./primitives/stream-card.tsx";
export { ChannelAvatar, type ChannelAvatarProps, type Accent } from "./primitives/channel-avatar.tsx";
export { LiveBadge, type LiveBadgeProps } from "./primitives/live-badge.tsx";
export { StatusBadge, type StatusBadgeProps, type StatusTone } from "./primitives/status-badge.tsx";
export { OverlayBadge, type OverlayBadgeProps } from "./primitives/overlay-badge.tsx";
export { AccentButton, type AccentButtonProps } from "./primitives/accent-button.tsx";
export { ViewerCount, type ViewerCountProps } from "./primitives/viewer-count.tsx";
export { RelativeTime, type RelativeTimeProps } from "./primitives/relative-time.tsx";
export { MoneyAmount, type MoneyAmountProps, type MoneyValue } from "./primitives/money-amount.tsx";
export { EmptyState, type EmptyStateProps } from "./primitives/empty-state.tsx";
export {
  Skeleton,
  SkeletonGroup,
  SkeletonText,
  SkeletonAvatar,
  SkeletonThumbnail,
  SkeletonButton,
  StreamCardSkeleton,
  type AvatarSize,
} from "./primitives/skeletons.tsx";
export { IconButton, type IconButtonProps } from "./primitives/icon-button.tsx";
export { ConfirmDialog, type ConfirmDialogProps } from "./primitives/confirm-dialog.tsx";
export {
  Kbd,
  KbdGroup,
  Shortcut,
  keyLabel,
  usePlatform,
  type Platform,
  type ShortcutProps,
} from "./primitives/shortcut.tsx";
export {
  CommandPalette,
  matchesQuery,
  type CommandPaletteProps,
  type CommandPaletteGroup,
  type CommandPaletteItem,
} from "./primitives/command-palette.tsx";
export {
  ThemeToggle,
  THEMES,
  applyTheme,
  isTheme,
  useResolvedTheme,
  type Theme,
  type ThemeToggleProps,
} from "./primitives/theme-toggle.tsx";
export { TooltipProvider } from "./components/tooltip.tsx";
