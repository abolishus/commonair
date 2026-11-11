// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The one-time first-follow alert prompt (README D4.3, voice-copy §4.7, the mockups'
 * `?state=firstfollow` and `firstfollow-ios`): "Get told when {channel} goes live?" with Push,
 * Email and Not now. It also stands in for the push-notification offer. Push reuses the push
 * client (permission only from this click, the go-live push default turned on); Email turns the
 * go-live email default on. On iOS before the site is on the Home Screen it never offers Push:
 * Email and an Add to Home Screen hint. Non-modal, anchored to the Follow control; Escape or Not
 * now dismisses it. Counted as `watch.firstFollow` view | click | dismiss with the answer.
 */
import { SITE } from "@commonair/config/site";
import { ChannelAvatar } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@commonair/ui/components/popover";
import { toast } from "@commonair/ui/toast";
import { Mail01Icon, Notification03Icon, SmartPhone01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api } from "../../lib/api.ts";
import { trackUi } from "../../lib/ui-metrics.ts";
import type { GateChannel } from "../auth-gate/auth-gate-prompt.tsx";
import { browserPushEnv, turnPushOn, type PushEnv } from "../pwa/push-client.ts";
import { alertOptions, browserAlertEnv, type AlertEnv } from "./alert-options.ts";

export type EnableEmailAlerts = () => Promise<unknown>;

const apiEnableEmail: EnableEmailAlerts = () =>
  api().notifications.preferences.set({ type: "go_live", medium: "email", channel: null, enabled: true });

export interface FirstFollowPromptProps {
  open: boolean;
  /** The prompt closed (answered or dismissed); the caller puts focus back on its control. */
  onClose: () => void;
  channel: GateChannel;
  /** Injected in tests. */
  alertEnv?: AlertEnv;
  pushEnv?: PushEnv;
  enableEmail?: EnableEmailAlerts;
  /** Where focus goes when the prompt closes. */
  finalFocus?: React.RefObject<HTMLElement | null>;
}

type Notice = "pushBlocked" | "pushUnavailable" | null;

export function FirstFollowPrompt({
  open,
  onClose,
  channel,
  alertEnv,
  pushEnv,
  enableEmail = apiEnableEmail,
  finalFocus,
}: FirstFollowPromptProps): React.JSX.Element {
  const [env] = React.useState(() => alertEnv ?? browserAlertEnv());
  const [push] = React.useState(() => pushEnv ?? browserPushEnv());
  const options = alertOptions(env);
  // Push is offered once the instance says it sends push (never a permission ask for nothing).
  const [pushOffered, setPushOffered] = React.useState(false);
  const [busy, setBusy] = React.useState<"push" | "email" | null>(null);
  const [notice, setNotice] = React.useState<Notice>(null);
  const titleId = React.useId();

  React.useEffect(() => {
    if (!open) return;
    trackUi("watch.firstFollow", "view", options.installHint ? "install" : options.push ? "push" : "email");
  }, [open, options.installHint, options.push]);

  React.useEffect(() => {
    if (!open || !options.push) return;
    let live = true;
    push.api
      .status()
      .then((s) => {
        if (live) setPushOffered(s.enabled && s.vapidPublicKey !== null);
      })
      .catch(() => {
        if (live) setPushOffered(false);
      });
    return () => {
      live = false;
    };
  }, [open, options.push, push]);

  const name = channel.name;
  const dismiss = () => {
    if (busy) return;
    trackUi("watch.firstFollow", "dismiss", "none");
    onClose();
  };
  const choosePush = async () => {
    trackUi("watch.firstFollow", "click", "push");
    setBusy("push");
    setNotice(null);
    try {
      const state = await turnPushOn(push);
      if (state === "on") {
        toast.success(t("d4Follow.alertPrompt.done", { method: "push", channel: name }));
        onClose();
      } else if (state === "denied") {
        setPushOffered(false);
        setNotice("pushBlocked");
      } else if (state === "unavailable" || state === "unsupported") {
        setPushOffered(false);
        setNotice("pushUnavailable");
      }
      // "off": the browser's own prompt was dismissed; the choice stays open.
    } catch (err) {
      toastActionError(err, t("d4Follow.alertPrompt.failed"));
    } finally {
      setBusy(null);
    }
  };
  const chooseEmail = async () => {
    trackUi("watch.firstFollow", "click", "email");
    setBusy("email");
    try {
      await enableEmail();
      toast.success(t("d4Follow.alertPrompt.done", { method: "email", channel: name }));
      onClose();
    } catch (err) {
      toastActionError(err, t("d4Follow.alertPrompt.failed"));
    } finally {
      setBusy(null);
    }
  };

  const showPush = options.push && pushOffered;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      {/* The anchor only: the prompt opens from the follow, never from a press of its own. */}
      <PopoverTrigger
        nativeButton={false}
        tabIndex={-1}
        aria-hidden
        render={<span data-slot="first-follow-anchor" className="pointer-events-none absolute inset-x-0 bottom-0" />}
      />
      <PopoverContent
        data-testid="first-follow-prompt"
        data-install-hint={options.installHint ? "true" : undefined}
        aria-labelledby={titleId}
        side="bottom"
        align="end"
        sideOffset={8}
        {...(finalFocus ? { finalFocus } : {})}
        className="w-80 max-w-viewport-4 gap-3 p-4 motion-reduce:animate-none"
      >
        <div className="flex items-start gap-3">
          <ChannelAvatar name={name} src={channel.avatarUrl ?? null} accent={channel.accent ?? null} decorative />
          <div className="flex min-w-0 flex-col gap-1">
            <PopoverTitle id={titleId} className="text-base/snug font-semibold text-foreground">
              {t("d4Follow.alertPrompt.title", { channel: name })}
            </PopoverTitle>
            <PopoverDescription className="text-sm/relaxed text-muted-foreground">
              {t("d4Follow.alertPrompt.body")}
            </PopoverDescription>
          </div>
        </div>
        {notice ? (
          <p data-testid="first-follow-notice" role="alert" className="text-sm/relaxed text-foreground">
            {notice === "pushBlocked"
              ? t("d4Follow.alertPrompt.pushBlocked")
              : t("d4Follow.alertPrompt.pushUnavailable")}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {showPush ? (
            <Button
              data-testid="first-follow-push"
              data-filled-cta=""
              variant="brand"
              size="sm"
              disabled={busy !== null}
              aria-busy={busy === "push" || undefined}
              onClick={() => void choosePush()}
            >
              <HugeiconsIcon icon={Notification03Icon} strokeWidth={2} aria-hidden />
              {t("d4Follow.alertPrompt.push")}
            </Button>
          ) : null}
          <Button
            data-testid="first-follow-email"
            {...(showPush ? {} : { "data-filled-cta": "" })}
            variant={showPush ? "outline" : "brand"}
            size="sm"
            disabled={busy !== null}
            aria-busy={busy === "email" || undefined}
            onClick={() => void chooseEmail()}
          >
            <HugeiconsIcon icon={Mail01Icon} strokeWidth={2} aria-hidden />
            {showPush ? t("d4Follow.alertPrompt.email") : t("d4Follow.alertPrompt.emailMe")}
          </Button>
          <Button
            data-testid="first-follow-dismiss"
            variant="ghost"
            size="sm"
            className="ms-auto"
            disabled={busy !== null}
            onClick={dismiss}
          >
            {t("d4Follow.alertPrompt.dismiss")}
          </Button>
        </div>
        {options.installHint ? (
          <div data-testid="first-follow-install" className="flex items-start gap-2 bg-muted p-3 text-sm">
            <HugeiconsIcon icon={SmartPhone01Icon} strokeWidth={2} aria-hidden className="mt-0.5 shrink-0" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="font-medium">{t("d4Follow.alertPrompt.installTitle")}</p>
              <p className="text-muted-foreground">{t("d4Follow.alertPrompt.iosInstall", { site: SITE.name })}</p>
            </div>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
