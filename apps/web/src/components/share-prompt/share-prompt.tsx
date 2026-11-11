// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "You're live: tell people" (overhaul wave 5, J2-e): the one message the LiveStatusBar's slot
 * carries during a channel's first stream. Copy link puts the channel's address on the clipboard;
 * Share opens the device's own share sheet (the Web Share API) where the browser has one. No
 * third-party SDKs or share URLs. Dismissed once per channel, in this browser.
 */
import { IconButton } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import { Cancel01Icon, Copy01Icon, Share08Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { trackUi } from "../../lib/ui-metrics.ts";
import { type ShareFn, channelLink, dismissSharePrompt, webShare } from "./model.ts";

export interface SharePromptProps {
  channel: string;
  /** The origin the channel page is served from; the browser's own by default. */
  origin?: string;
  /** The Web Share API, or null without one; the browser's by default. */
  share?: ShareFn | null;
  onDismiss: () => void;
}

const browserOrigin = () => (typeof window === "undefined" ? "" : window.location.origin);
const browserShare = () => webShare(typeof navigator === "undefined" ? undefined : navigator);

export function SharePrompt({
  channel,
  origin = browserOrigin(),
  share = browserShare(),
  onDismiss,
}: SharePromptProps): React.JSX.Element {
  const url = channelLink(origin, channel);
  React.useEffect(() => {
    trackUi("studio.sharePrompt", "view");
  }, []);

  const copy = async () => {
    trackUi("studio.sharePrompt", "click", "copy");
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("w5Studio.share.copied"));
    } catch {
      toast.error(t("w5Studio.share.copyFailed"));
    }
  };
  const shareNow = async (fn: ShareFn) => {
    trackUi("studio.sharePrompt", "click", "share");
    try {
      await fn({ title: t("w5Studio.share.shareTitle"), url });
    } catch {
      // Closing the share sheet rejects too; nothing to tell.
    }
  };

  return (
    <span data-testid="studio-share-prompt" className="flex min-w-0 flex-wrap items-center gap-2">
      {/* An <output>: announced once when the prompt appears, politely. */}
      <output className="text-sm font-medium">{t("w5Studio.share.title")}</output>
      <Button data-testid="studio-share-copy" variant="outline" size="sm" onClick={() => void copy()}>
        <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
        {t("w5Studio.share.copy")}
      </Button>
      {share ? (
        <Button data-testid="studio-share-native" variant="outline" size="sm" onClick={() => void shareNow(share)}>
          <HugeiconsIcon icon={Share08Icon} strokeWidth={2} aria-hidden data-icon="inline-start" />
          {t("w5Studio.share.share")}
        </Button>
      ) : null}
      <IconButton
        data-testid="studio-share-dismiss"
        label={t("w5Studio.share.dismiss")}
        icon={Cancel01Icon}
        variant="ghost"
        onClick={() => {
          trackUi("studio.sharePrompt", "dismiss");
          dismissSharePrompt(channel);
          onDismiss();
        }}
      />
    </span>
  );
}
