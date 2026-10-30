// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Button } from "@commonair/ui/components/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@commonair/ui/components/input-group";
import { ScrollArea } from "@commonair/ui/components/scroll-area";
import { StatusBadge } from "@commonair/ui";
import { cn } from "@commonair/ui/lib/utils";

export interface ChatPanelProps extends React.ComponentProps<"section"> {
  title: string;
  collapseAction?: React.ReactNode;
  viewersAction?: React.ReactNode;
  pinned?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  variant?: "live" | "replay" | "mobile";
  logLabel: string;
  newMessagesLabel: string;
  onJumpToLatest?: () => void;
  /** `off` when another live region summarizes the log (Calm Chat's digest). */
  logLive?: "polite" | "off";
}

export function ChatPanel({
  title,
  collapseAction,
  viewersAction,
  pinned,
  footer,
  children,
  variant = "live",
  logLabel,
  newMessagesLabel,
  onJumpToLatest,
  logLive = "polite",
  className,
  ...props
}: ChatPanelProps): React.JSX.Element {
  const scrollAreaRef = React.useRef<HTMLDivElement>(null);
  const [showLatest, setShowLatest] = React.useState(false);
  const atBottomRef = React.useRef(true);
  const getViewport = (): HTMLElement | null =>
    scrollAreaRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null;

  React.useEffect(() => {
    const viewport = getViewport();
    if (!viewport) return;
    const updateScrollPosition = () => {
      atBottomRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48;
      setShowLatest(!atBottomRef.current);
    };
    viewport.addEventListener("scroll", updateScrollPosition);
    return () => viewport.removeEventListener("scroll", updateScrollPosition);
  }, []);
  React.useEffect(() => {
    const viewport = getViewport();
    if (!viewport) return;
    if (atBottomRef.current) viewport.scrollTop = viewport.scrollHeight;
    setShowLatest(!atBottomRef.current);
  }, [children]);
  const jump = () => {
    const viewport = getViewport();
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
    atBottomRef.current = true;
    setShowLatest(false);
    onJumpToLatest?.();
  };
  return (
    <section
      data-slot="chat-panel"
      data-state={variant}
      className={cn("flex min-h-0 min-w-0 flex-col border border-border bg-card", className)}
      {...props}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="min-w-0 truncate text-sm font-semibold">{title}</h2>
        <div className="flex shrink-0 items-center gap-1">
          {viewersAction}
          {collapseAction}
        </div>
      </header>
      {pinned && (
        <div data-slot="chat-pinned" className="border-b border-border p-2">
          {pinned}
        </div>
      )}
      <ScrollArea ref={scrollAreaRef} className="relative min-h-0 flex-1">
        <div
          role="log"
          aria-label={logLabel}
          aria-live={logLive}
          data-slot="chat-log"
          className="flex min-h-48 flex-col gap-1 p-3 text-xs"
        >
          {children}
        </div>
        {showLatest && (
          <Button type="button" size="sm" variant="secondary" onClick={jump} className="absolute end-2 bottom-2">
            {newMessagesLabel}
          </Button>
        )}
      </ScrollArea>
      {footer && <footer className="border-t border-border p-2">{footer}</footer>}
    </section>
  );
}

export type ChatBadgeKind = "broadcaster" | "moderator" | "subscriber" | "member" | "vip";

export interface ChatBadgeProps extends React.ComponentProps<typeof StatusBadge> {
  kind: ChatBadgeKind;
  label: string;
}

export function ChatBadge({ kind, label, ...props }: ChatBadgeProps): React.JSX.Element {
  const tone =
    kind === "broadcaster"
      ? "danger"
      : kind === "moderator"
        ? "success"
        : kind === "vip"
          ? "warning"
          : kind === "member"
            ? "accent"
            : "neutral";
  return (
    <StatusBadge tone={tone} aria-label={label} data-chat-badge={kind} {...props}>
      {label}
    </StatusBadge>
  );
}

export interface ChatMessageProps extends React.ComponentProps<"article"> {
  author: string;
  body: React.ReactNode;
  colorIndex: number;
  badges?: Array<{ kind: ChatBadgeKind; label: string }>;
  timestamp?: React.ReactNode;
  highlight?: boolean;
  deleted?: boolean;
  deletedLabel?: string;
  action?: boolean;
  actions?: React.ReactNode;
  notice?: boolean;
}

const CHAT_COLORS = Array.from({ length: 12 }, (_, index) => `text-chat-${index + 1}`);

export function ChatMessage({
  author,
  body,
  colorIndex,
  badges = [],
  timestamp,
  highlight = false,
  deleted = false,
  deletedLabel,
  action = false,
  actions,
  notice = false,
  className,
  ...props
}: ChatMessageProps): React.JSX.Element {
  if (notice)
    return (
      <article data-slot="chat-notice" className={cn("break-words py-1 text-muted-foreground", className)} {...props}>
        {body}
      </article>
    );
  const color = CHAT_COLORS[(((Math.trunc(colorIndex) - 1) % 12) + 12) % 12] ?? CHAT_COLORS[0];
  return (
    <article
      data-slot="chat-message"
      data-highlight={highlight || undefined}
      data-deleted={deleted || undefined}
      className={cn("flex min-w-0 items-start gap-1 py-0.5", highlight && "bg-muted", className)}
      {...props}
    >
      {timestamp && <time className="shrink-0 tabular-nums text-muted-foreground">{timestamp}</time>}
      <p className="min-w-0 flex-1 break-words">
        <span className={cn("font-semibold", color)}>{author}</span>
        {badges.map((badge) => (
          <ChatBadge key={badge.kind} kind={badge.kind} label={badge.label} className="mx-0.5 align-middle" />
        ))}
        <span aria-hidden className="text-muted-foreground">
          :{" "}
        </span>
        {deleted ? (
          <span className="italic text-muted-foreground">{deletedLabel}</span>
        ) : (
          <span className={action ? "italic" : undefined}>{body}</span>
        )}
      </p>
      {actions}
    </article>
  );
}

export interface ChatComposerProps extends Omit<React.ComponentProps<"form">, "onSubmit"> {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  sendLabel: string;
  disabled?: boolean;
  maxLength?: number;
  emoteAction?: React.ReactNode;
  pointsAction?: React.ReactNode;
  modeNote?: React.ReactNode;
  signin?: React.ReactNode;
  inputProps?: React.ComponentProps<"input"> & { "data-testid"?: string; [key: `data-${string}`]: unknown };
  sendProps?: React.ComponentProps<typeof Button> & { "data-testid"?: string; [key: `data-${string}`]: unknown };
}

export function ChatComposer({
  value,
  onValueChange,
  onSubmit,
  placeholder,
  sendLabel,
  disabled = false,
  maxLength = 500,
  emoteAction,
  pointsAction,
  modeNote,
  signin,
  inputProps,
  sendProps,
  className,
  ...props
}: ChatComposerProps): React.JSX.Element {
  if (signin)
    return (
      <form
        data-slot="chat-signin-prompt"
        className={cn("flex flex-wrap items-center gap-2 text-xs text-muted-foreground", className)}
        {...props}
      >
        {signin}
      </form>
    );
  return (
    <form
      data-slot="chat-composer"
      className={cn("flex min-w-0 flex-col gap-2", className)}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      {...props}
    >
      {modeNote}
      <div className="flex min-w-0 gap-2">
        {pointsAction}
        <InputGroup>
          {emoteAction && <InputGroupAddon align="inline-end">{emoteAction}</InputGroupAddon>}
          <InputGroupInput
            {...inputProps}
            data-testid={inputProps?.["data-testid"] ?? "chat-input"}
            value={value}
            onChange={(event) => onValueChange(event.currentTarget.value)}
            maxLength={maxLength}
            placeholder={placeholder}
            aria-label={placeholder}
            disabled={disabled}
          />
        </InputGroup>
        <Button
          {...sendProps}
          type="submit"
          data-testid={sendProps?.["data-testid"] ?? "chat-send"}
          disabled={disabled || !value.trim()}
        >
          {sendLabel}
        </Button>
      </div>
    </form>
  );
}

export function ChatReplayFooter({ children, className, ...props }: React.ComponentProps<"p">): React.JSX.Element {
  return (
    <p data-slot="chat-replay-footer" className={cn("text-center text-xs text-muted-foreground", className)} {...props}>
      {children}
    </p>
  );
}
