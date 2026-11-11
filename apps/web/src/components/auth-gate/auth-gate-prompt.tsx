// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `<AuthGatePrompt intent>` (README D2.1): the one prompt every signed-out action opens, instead
 * of a bare "Sign in" link. It says what the action needs and that the account is free; "Create
 * account" is the screen's one brand fill (`data-filled-cta`, so the header's Sign up drops to an
 * outline beside it) and "Sign in" the second, both carrying `?redirect` (this page), `?intent` and
 * the channel. Report is the exception: Sign in leads, with no brand fill. Copy: voice-copy §4.6.
 *
 * It is a popover anchored to the action (focus moves into it and stays there while it is open;
 * Escape or Close dismisses it and focus returns to the action), a dialog where there is nothing
 * to anchor to (a menu item), or an inline panel where the action is the whole surface (the 18+
 * gate). Counted with `trackUi("authGate", view | create | signin, intent)`.
 */
import { ChannelAvatar, IconButton, type Accent } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@commonair/ui/components/dialog";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@commonair/ui/components/popover";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t, type MessageKey } from "../../i18n/index.ts";
import { trackUi } from "../../lib/ui-metrics.ts";
import { authRedirectFor } from "../shell/auth-redirect.ts";
import { channelSlugOf, gateSearch, signInLeads, type GateIntent, type GateSearch } from "./intents.ts";
import { useGateLocation } from "./router-state.ts";

export interface GateChannel {
  slug: string;
  /** The display name the title uses. */
  name: string;
  avatarUrl?: string | null;
  accent?: Accent | null;
}

export interface AuthGateCopyProps {
  intent: GateIntent;
  channel?: GateChannel | null;
  /** Support only: the creator's share in whole percent, when it is known (never guessed). */
  creatorShare?: number | null;
}

const TITLES: Record<GateIntent, MessageKey> = {
  follow: "d2Gate.follow.title",
  chat: "d2Gate.chat.title",
  support: "d2Gate.support.title",
  predict: "d2Gate.predict.title",
  clip: "d2Gate.clip.title",
  watch: "d2Gate.watch.title",
  stream: "d2Gate.stream.title",
  import: "d2Gate.import.title",
  join: "d2Gate.join.title",
  vote: "d2Gate.vote.title",
  report: "d2Gate.report.title",
};
const BODIES: Record<GateIntent, MessageKey> = {
  follow: "d2Gate.follow.body",
  chat: "d2Gate.chat.body",
  support: "d2Gate.support.body",
  predict: "d2Gate.predict.body",
  clip: "d2Gate.clip.body",
  watch: "d2Gate.watch.body",
  stream: "d2Gate.stream.body",
  import: "d2Gate.import.body",
  join: "d2Gate.join.body",
  vote: "d2Gate.vote.body",
  report: "d2Gate.report.body",
};

/**
 * The channel a prompt is about: the caller's, else the matched `$channel` route param (its slug
 * stands in for the display name), else none.
 */
export function useGateChannel(channel: GateChannel | null | undefined): GateChannel | null {
  const params = useGateLocation()?.params ?? {};
  if (channel) return channel;
  const slug = channelSlugOf(params.channel);
  return slug === undefined ? null : { slug, name: slug };
}

/** The prompt's title and body for an intent (a stale link without a channel gets the generic title). */
export function gateCopy({ intent, channel, creatorShare }: AuthGateCopyProps): { title: string; body: string } {
  const name = channel?.name.trim();
  let title: string;
  if (intent === "follow" && !name) title = t("d2Gate.follow.titleNoChannel");
  else if (intent === "support" && !name) title = t("d2Gate.support.titleNoChannel");
  else title = t(TITLES[intent], { channel: name ?? "" });
  const share = typeof creatorShare === "number" && Number.isFinite(creatorShare) ? Math.round(creatorShare) : null;
  const body =
    intent === "support"
      ? share === null
        ? t("d2Gate.support.bodyNoShare")
        : t("d2Gate.support.body", { creatorShare: share })
      : t(BODIES[intent]);
  return { title, body };
}

/** The search both buttons carry: this page (unless it is home or an auth page), the intent, the channel. */
export function useGateSearch(intent: GateIntent, channel?: GateChannel | null): GateSearch {
  const href = useGateLocation()?.href ?? "/";
  return gateSearch(intent, authRedirectFor(href), channel?.slug);
}

/** "Create account" and "Sign in", in the intent's order and weight. */
export function AuthGateActions({
  intent,
  channel,
  size = "default",
  className,
  testIds,
}: {
  intent: GateIntent;
  channel?: GateChannel | null;
  size?: "default" | "lg";
  className?: string;
  /** The surface's own selectors for the two buttons, where it already has them. */
  testIds?: { create?: string; signIn?: string } | undefined;
}): React.JSX.Element {
  const search = useGateSearch(intent, channel);
  const signInFirst = signInLeads(intent);
  const create = (
    <Button
      key="create"
      data-testid={testIds?.create ?? "auth-gate-create"}
      variant={signInFirst ? "ghost" : "brand"}
      size={size}
      {...(signInFirst ? {} : { "data-filled-cta": "" })}
      className={signInFirst ? undefined : "flex-1"}
      nativeButton={false}
      render={<Link to="/signup" search={search} onClick={() => trackUi("authGate", "create", intent)} />}
    >
      {t("d2Gate.create")}
    </Button>
  );
  const signIn = (
    <Button
      key="signin"
      data-testid={testIds?.signIn ?? "auth-gate-signin"}
      variant={signInFirst ? "default" : "ghost"}
      size={size}
      className={signInFirst ? "flex-1" : undefined}
      nativeButton={false}
      render={<Link to="/signin" search={search} onClick={() => trackUi("authGate", "signin", intent)} />}
    >
      {t("d2Gate.signIn")}
    </Button>
  );
  return (
    <div data-slot="auth-gate-actions" className={className ?? "flex flex-wrap items-center gap-2"}>
      {signInFirst ? [signIn, create] : [create, signIn]}
    </div>
  );
}

function GateHeader({
  channel,
  title,
  titleId,
  as: Title,
}: {
  channel?: GateChannel | null;
  title: string;
  titleId?: string;
  as: React.ElementType;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5 pe-8">
      {channel ? (
        <ChannelAvatar
          name={channel.name}
          src={channel.avatarUrl ?? null}
          accent={channel.accent ?? null}
          size="sm"
          decorative
        />
      ) : null}
      <Title id={titleId} className="text-base/snug font-semibold text-foreground">
        {title}
      </Title>
    </div>
  );
}

export interface AuthGatePromptProps extends AuthGateCopyProps {
  /**
   * The action's own control, as the popover's trigger (`render`): a `<Button>` or an
   * `<AccentButton>`; its children go in `children`.
   */
  trigger: React.ReactElement<Record<string, unknown>>;
  children?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
}

/** The prompt as a popover on the action's own control. */
export function AuthGatePrompt({
  intent,
  channel,
  creatorShare,
  trigger,
  children,
  open: controlled,
  onOpenChange,
  side = "bottom",
  align = "start",
}: AuthGatePromptProps): React.JSX.Element {
  const [uncontrolled, setUncontrolled] = React.useState(false);
  const open = controlled ?? uncontrolled;
  const setOpen = (next: boolean) => {
    if (controlled === undefined) setUncontrolled(next);
    onOpenChange?.(next);
  };
  React.useEffect(() => {
    if (open) trackUi("authGate", "view", intent);
  }, [open, intent]);
  const ch = useGateChannel(channel);
  const { title, body } = gateCopy({ intent, channel: ch, creatorShare });
  return (
    <Popover open={open} onOpenChange={setOpen} modal="trap-focus">
      <PopoverTrigger render={trigger} data-auth-gate={intent}>
        {children}
      </PopoverTrigger>
      <PopoverContent
        data-testid="auth-gate"
        data-intent={intent}
        side={side}
        align={align}
        sideOffset={8}
        className="relative w-80 max-w-viewport-4 gap-3 p-4 motion-reduce:animate-none"
      >
        <IconButton
          data-testid="auth-gate-close"
          variant="ghost"
          size="icon-sm"
          icon={Cancel01Icon}
          label={t("d2Gate.close")}
          className="absolute end-1.5 top-1.5"
          onClick={() => setOpen(false)}
        />
        <GateHeader channel={ch} title={title} as={PopoverTitle} />
        <PopoverDescription className="text-sm/relaxed text-muted-foreground">{body}</PopoverDescription>
        <AuthGateActions intent={intent} channel={ch} />
      </PopoverContent>
    </Popover>
  );
}

/** The prompt as a modal dialog, for an action with nothing on screen to anchor to (a menu item). */
export function AuthGateDialog({
  intent,
  channel,
  creatorShare,
  open,
  onOpenChange,
  finalFocus,
}: AuthGateCopyProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  finalFocus?: React.RefObject<HTMLElement | null>;
}): React.JSX.Element {
  React.useEffect(() => {
    if (open) trackUi("authGate", "view", intent);
  }, [open, intent]);
  const ch = useGateChannel(channel);
  const { title, body } = gateCopy({ intent, channel: ch, creatorShare });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent
          data-testid="auth-gate"
          data-intent={intent}
          className="gap-3 sm:max-w-sm"
          {...(finalFocus ? { finalFocus } : {})}
        >
          <GateHeader channel={ch} title={title} as={DialogTitle} />
          <DialogDescription className="text-sm/relaxed">{body}</DialogDescription>
          <AuthGateActions intent={intent} channel={ch} size="lg" />
        </DialogContent>
      )}
    </Dialog>
  );
}

/**
 * The prompt inline, where the gated action is the whole surface (the 18+ gate over the player).
 * `testIds` keep the surface's own selectors on its buttons (harness and tests read them), or
 * `actions` replaces the buttons outright (built with `useGateSearch`).
 */
export function AuthGatePanel({
  intent,
  channel,
  creatorShare,
  className,
  testIds,
  actions,
  "data-testid": testId,
}: AuthGateCopyProps & {
  className?: string;
  testIds?: { create?: string; signIn?: string };
  actions?: React.ReactNode;
  "data-testid"?: string;
}): React.JSX.Element {
  const titleId = React.useId();
  React.useEffect(() => trackUi("authGate", "view", intent), [intent]);
  const ch = useGateChannel(channel);
  const { title, body } = gateCopy({ intent, channel: ch, creatorShare });
  return (
    <section
      data-testid={testId ?? "auth-gate"}
      data-intent={intent}
      aria-labelledby={titleId}
      className={className ?? "flex max-w-sm flex-col items-center gap-3 text-center"}
    >
      <h2 id={titleId} className="text-lg/snug font-semibold text-foreground">
        {title}
      </h2>
      <p className="text-sm/relaxed text-muted-foreground">{body}</p>
      {actions ?? (
        <AuthGateActions
          intent={intent}
          channel={ch}
          size="lg"
          testIds={testIds}
          className="flex flex-wrap justify-center gap-2"
        />
      )}
    </section>
  );
}
