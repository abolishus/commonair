// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Signed-out Support (README D2.1): the channel's Support button opens the sign-up prompt. The
 * creator's share comes from `money.support` (public) when the prompt opens, so the body states
 * the real figure or none at all.
 */
import { AccentButton, type Accent } from "@commonair/ui";
import { FavouriteIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { splitPercents, type SupportInfo } from "../../lib/support.ts";
import { AuthGatePrompt } from "./auth-gate-prompt.tsx";

export type SupportSplitLoader = (channel: string) => Promise<SupportInfo["split"]>;

const apiSplit: SupportSplitLoader = async (channel) => (await api().money.support({ channel })).split;

export interface GatedSupportButtonProps {
  channel: string;
  channelName: string;
  accent?: Accent | null;
  loadSplit?: SupportSplitLoader;
}

export function GatedSupportButton({
  channel,
  channelName,
  accent = null,
  loadSplit = apiSplit,
}: GatedSupportButtonProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [share, setShare] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!open || share !== null) return;
    let live = true;
    loadSplit(channel)
      .then((split) => {
        if (live) setShare(splitPercents(split).creator);
      })
      // Unknown: the prompt says it without a number.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, share, channel, loadSplit]);
  return (
    <AuthGatePrompt
      intent="support"
      channel={{ slug: channel, name: channelName, accent }}
      creatorShare={share}
      open={open}
      onOpenChange={setOpen}
      align="end"
      trigger={<AccentButton data-testid="support-open" size="sm" accent={accent} />}
    >
      <HugeiconsIcon icon={FavouriteIcon} strokeWidth={2} aria-hidden />
      {t("support.open")}
    </AuthGatePrompt>
  );
}
